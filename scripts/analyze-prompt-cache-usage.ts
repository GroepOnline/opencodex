#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  normalizePromptCacheRequestObservation,
  type PromptCacheRequestObservation,
} from "../src/prompt-cache/observability";

type RangeName = "7d" | "30d" | "all";
type CohortSignal = "write-heavy" | "low-reuse" | "healthy" | "mixed";

interface AnalyzerOptions {
  source: string;
  range: RangeName;
  top: number;
  nowMs: number;
  jsonMode: boolean;
  help: boolean;
}

interface CacheUsage {
  input: number;
  read: number;
  write: number;
}

interface CohortDimensions {
  adapter: string;
  provider: string;
  model: string;
  surface: string;
}

interface Cohort extends CohortDimensions {
  requests: number;
  reportedSuccess: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  uncachedInput: number;
  hitRequests: number;
  writeRequests: number;
  conversations: Map<string, number>;
}

interface CohortSummary extends CohortDimensions {
  signal: CohortSignal;
  requests: number;
  reportedSuccess: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  uncachedInputTokens: number;
  cacheReadRatio: number;
  cacheWriteRatio: number;
  cacheHitRequestRatio: number;
  cacheWriteRequestRatio: number;
  conversations: number;
  multiTurnConversations: number;
}

interface ShapeBucket {
  dimensions: CohortDimensions;
  observation: PromptCacheRequestObservation;
  rows: Record<string, unknown>[];
}

interface ShapeSummary extends CohortDimensions {
  mode: PromptCacheRequestObservation["mode"];
  ttl: PromptCacheRequestObservation["ttl"] | null;
  keyPresent: boolean;
  breakpointCount: number;
  toolCount: number;
  toolsFingerprint: string | null;
  stablePrefixFingerprint: string | null;
  textFormatFingerprint: string | null;
  verbosity: string | null;
  requests: number;
  reportedSuccess: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheReadRatio: number;
  cacheWriteRatio: number;
}

function usageText(): string {
  return [
    "Usage: bun scripts/analyze-prompt-cache-usage.ts [usage.jsonl|-] [options]",
    "",
    "Options:",
    "  --range=7d|30d|all    Analysis window (default: 7d)",
    "  --top=N                Maximum cohorts/shapes to print, 1..200 (default: 20)",
    "  --now=ISO|epoch-ms     Anchor relative windows for reproducible analysis",
    "  --json                 Emit JSON",
    "  --help                 Show this help",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseRange(value: string): RangeName {
  if (value === "7d" || value === "30d" || value === "all") return value;
  throw new Error(`invalid --range value: ${value}`);
}

function parseTop(value: string): number {
  if (!/^\d+$/u.test(value)) throw new Error(`invalid --top value: ${value}`);
  const parsed = Number.parseInt(value, 10);
  if (parsed < 1 || parsed > 200) throw new Error("--top must be between 1 and 200");
  return parsed;
}

function parseNow(value: string): number {
  if (/^\d+$/u.test(value)) {
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric) && numeric >= 0) return numeric;
  }
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  throw new Error(`invalid --now value: ${value}`);
}

function parseArgs(args: string[]): AnalyzerOptions {
  const defaultSource = join(
    process.env.OPENCODEX_HOME?.trim() || join(homedir(), ".opencodex"),
    "usage.jsonl",
  );
  let source = defaultSource;
  let positionalSeen = false;
  let range: RangeName = "7d";
  let top = 20;
  let nowMs = Date.now();
  let jsonMode = false;
  let help = false;

  for (const arg of args) {
    if (arg === "--json") {
      jsonMode = true;
      continue;
    }
    if (arg === "--help") {
      help = true;
      continue;
    }
    if (arg.startsWith("--range=")) {
      range = parseRange(arg.slice("--range=".length));
      continue;
    }
    if (arg.startsWith("--top=")) {
      top = parseTop(arg.slice("--top=".length));
      continue;
    }
    if (arg.startsWith("--now=")) {
      nowMs = parseNow(arg.slice("--now=".length));
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
    if (positionalSeen) throw new Error("only one usage-log path may be supplied");
    source = arg;
    positionalSeen = true;
  }

  return { source, range, top, nowMs, jsonMode, help };
}

function cacheUsage(row: Record<string, unknown>): CacheUsage | undefined {
  if (row.status !== 200 || row.usageStatus !== "reported" || !isRecord(row.usage)) {
    return undefined;
  }
  const input = nonNegativeNumber(row.usage.inputTokens);
  if (input === undefined) return undefined;
  const write = nonNegativeNumber(row.usage.cacheCreationInputTokens) ?? 0;
  let read: number;
  if (hasOwn(row.usage, "cacheReadInputTokens")) {
    const explicitRead = nonNegativeNumber(row.usage.cacheReadInputTokens);
    if (explicitRead === undefined) return undefined;
    read = explicitRead;
  } else {
    const legacyCached = nonNegativeNumber(row.usage.cachedInputTokens);
    read = (legacyCached !== undefined && row.usage.cacheCreationInputTokens !== undefined
      ? Math.max(0, legacyCached - write)
      : legacyCached) ?? 0;
  }
  if (read + write > input) return undefined;
  return { input, read, write };
}

function sinceFor(range: RangeName, nowMs: number): number {
  if (range === "all") return 0;
  return nowMs - (range === "7d" ? 7 : 30) * 86_400_000;
}

function dimensionsFrom(row: Record<string, unknown>): CohortDimensions {
  return {
    adapter: stringValue(row.adapter) ?? "unknown",
    provider: stringValue(row.provider) ?? "unknown",
    model: stringValue(row.resolvedModel) ?? stringValue(row.model) ?? "unknown",
    surface: stringValue(row.surface) ?? "unknown",
  };
}

function dimensionsKey(dimensions: CohortDimensions): string {
  return JSON.stringify([
    dimensions.adapter,
    dimensions.provider,
    dimensions.model,
    dimensions.surface,
  ]);
}

function emptyCohort(dimensions: CohortDimensions): Cohort {
  return {
    ...dimensions,
    requests: 0,
    reportedSuccess: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    uncachedInput: 0,
    hitRequests: 0,
    writeRequests: 0,
    conversations: new Map(),
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function signal(cohort: Cohort): CohortSignal {
  const readRatio = ratio(cohort.cacheRead, cohort.input);
  const writeRatio = ratio(cohort.cacheWrite, cohort.input);
  if (writeRatio >= 0.5 && readRatio < 0.1) return "write-heavy";
  if (cohort.input >= 1_000_000 && readRatio < 0.25) return "low-reuse";
  if (readRatio >= 0.75) return "healthy";
  return "mixed";
}

function summarizeCohort(cohort: Cohort): CohortSummary {
  let multiTurnConversations = 0;
  for (const count of cohort.conversations.values()) {
    if (count > 1) multiTurnConversations += 1;
  }
  return {
    adapter: cohort.adapter,
    provider: cohort.provider,
    model: cohort.model,
    surface: cohort.surface,
    signal: signal(cohort),
    requests: cohort.requests,
    reportedSuccess: cohort.reportedSuccess,
    inputTokens: cohort.input,
    cacheReadTokens: cohort.cacheRead,
    cacheWriteTokens: cohort.cacheWrite,
    uncachedInputTokens: cohort.uncachedInput,
    cacheReadRatio: ratio(cohort.cacheRead, cohort.input),
    cacheWriteRatio: ratio(cohort.cacheWrite, cohort.input),
    cacheHitRequestRatio: ratio(cohort.hitRequests, cohort.reportedSuccess),
    cacheWriteRequestRatio: ratio(cohort.writeRequests, cohort.reportedSuccess),
    conversations: cohort.conversations.size,
    multiTurnConversations,
  };
}

function cacheShapeKey(observation: PromptCacheRequestObservation): string {
  return JSON.stringify([
    observation.mode,
    observation.ttl ?? null,
    observation.keyPresent,
    observation.breakpointCount,
    observation.toolsFingerprint ?? null,
    observation.stablePrefixFingerprint ?? null,
    observation.textFormatFingerprint ?? null,
    observation.verbosity ?? null,
  ]);
}

function summarizeShape(bucket: ShapeBucket): ShapeSummary {
  const pc = bucket.observation;
  let input = 0;
  let read = 0;
  let write = 0;
  let reportedSuccess = 0;
  for (const row of bucket.rows) {
    const usage = cacheUsage(row);
    if (!usage) continue;
    reportedSuccess += 1;
    input += usage.input;
    read += usage.read;
    write += usage.write;
  }
  return {
    ...bucket.dimensions,
    mode: pc.mode,
    ttl: pc.ttl ?? null,
    keyPresent: pc.keyPresent,
    breakpointCount: pc.breakpointCount,
    toolCount: pc.toolCount,
    toolsFingerprint: pc.toolsFingerprint ?? null,
    stablePrefixFingerprint: pc.stablePrefixFingerprint ?? null,
    textFormatFingerprint: pc.textFormatFingerprint ?? null,
    verbosity: pc.verbosity ?? null,
    requests: bucket.rows.length,
    reportedSuccess,
    inputTokens: input,
    cacheReadTokens: read,
    cacheWriteTokens: write,
    cacheReadRatio: ratio(read, input),
    cacheWriteRatio: ratio(write, input),
  };
}

function formatPercent(value: number): string {
  return (value * 100).toFixed(1) + "%";
}

interface ParsedUsageRows {
  rows: Record<string, unknown>[];
  invalidLines: number;
}

interface AnalysisTotals {
  reportedSuccess: number;
  input: number;
  read: number;
  write: number;
}

interface AnalysisState {
  cohorts: Map<string, Cohort>;
  shapeBuckets: Map<string, ShapeBucket>;
  totals: AnalysisTotals;
}

function readUsageSource(options: AnalyzerOptions): string {
  return options.source === "-"
    ? readFileSync(0, "utf8")
    : readFileSync(options.source, "utf8");
}

function parseUsageRows(text: string): ParsedUsageRows {
  const rows: Record<string, unknown>[] = [];
  let invalidLines = 0;
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) rows.push(parsed);
      else invalidLines += 1;
    } catch {
      invalidLines += 1;
    }
  }
  return { rows, invalidLines };
}

function rowsInWindow(
  rows: readonly Record<string, unknown>[],
  since: number,
  nowMs: number,
): Record<string, unknown>[] {
  return rows.filter(row => {
    const timestamp = nonNegativeNumber(row.timestamp);
    return timestamp !== undefined && timestamp >= since && timestamp <= nowMs;
  });
}

function recordConversation(cohort: Cohort, row: Record<string, unknown>): void {
  const conversationId = stringValue(row.conversationId);
  if (!conversationId) return;
  cohort.conversations.set(
    conversationId,
    (cohort.conversations.get(conversationId) ?? 0) + 1,
  );
}

function recordCacheUsage(
  cohort: Cohort,
  usage: CacheUsage | undefined,
  totals: AnalysisTotals,
): void {
  if (!usage) return;
  cohort.reportedSuccess += 1;
  cohort.input += usage.input;
  cohort.cacheRead += usage.read;
  cohort.cacheWrite += usage.write;
  cohort.uncachedInput += Math.max(0, usage.input - usage.read - usage.write);
  if (usage.read > 0) cohort.hitRequests += 1;
  if (usage.write > 0) cohort.writeRequests += 1;
  totals.reportedSuccess += 1;
  totals.input += usage.input;
  totals.read += usage.read;
  totals.write += usage.write;
}

function recordCacheShape(
  buckets: Map<string, ShapeBucket>,
  key: string,
  dimensions: CohortDimensions,
  row: Record<string, unknown>,
): void {
  const observation = normalizePromptCacheRequestObservation(row.promptCache);
  if (!observation) return;
  const shapeKey = JSON.stringify([key, cacheShapeKey(observation)]);
  const existing = buckets.get(shapeKey);
  if (existing) {
    existing.rows.push(row);
    return;
  }
  buckets.set(shapeKey, { dimensions, observation, rows: [row] });
}

function analyzeRows(rows: readonly Record<string, unknown>[]): AnalysisState {
  const cohorts = new Map<string, Cohort>();
  const shapeBuckets = new Map<string, ShapeBucket>();
  const totals: AnalysisTotals = {
    reportedSuccess: 0,
    input: 0,
    read: 0,
    write: 0,
  };

  for (const row of rows) {
    const dimensions = dimensionsFrom(row);
    const key = dimensionsKey(dimensions);
    const cohort = cohorts.get(key) ?? emptyCohort(dimensions);
    cohorts.set(key, cohort);
    cohort.requests += 1;
    recordConversation(cohort, row);
    recordCacheUsage(cohort, cacheUsage(row), totals);
    recordCacheShape(shapeBuckets, key, dimensions, row);
  }

  return { cohorts, shapeBuckets, totals };
}

function topCohorts(cohorts: Map<string, Cohort>, top: number): CohortSummary[] {
  return [...cohorts.values()]
    .filter(cohort => cohort.reportedSuccess > 0)
    .sort((a, b) => b.input - a.input)
    .slice(0, top)
    .map(summarizeCohort);
}

function topShapes(
  buckets: Map<string, ShapeBucket>,
  top: number,
): ShapeSummary[] {
  return [...buckets.values()]
    .map(summarizeShape)
    .filter(shape => shape.reportedSuccess > 0)
    .sort((a, b) => b.inputTokens - a.inputTokens)
    .slice(0, top);
}

function buildOutput(
  options: AnalyzerOptions,
  since: number,
  selectedRows: number,
  invalidLines: number,
  analysis: AnalysisState,
) {
  const cohorts = topCohorts(analysis.cohorts, options.top);
  const cacheShapes = topShapes(analysis.shapeBuckets, options.top);
  const { reportedSuccess, input, read, write } = analysis.totals;
  return {
    source: options.source === "-" ? "stdin" : options.source,
    range: options.range,
    windowStartMs: since,
    windowEndMs: options.nowMs,
    windowStart: new Date(since).toISOString(),
    windowEnd: new Date(options.nowMs).toISOString(),
    rows: selectedRows,
    invalidLines,
    proofBoundary: "status=200 AND usageStatus=reported",
    summary: {
      reportedSuccess,
      inputTokens: input,
      cacheReadTokens: read,
      cacheWriteTokens: write,
      uncachedInputTokens: Math.max(0, input - read - write),
      cacheReadRatio: ratio(read, input),
      cacheWriteRatio: ratio(write, input),
    },
    cohorts,
    cacheShapes,
  };
}

type AnalyzerOutput = ReturnType<typeof buildOutput>;

function printHumanOutput(output: AnalyzerOutput): void {
  console.log("Prompt cache usage (" + output.range + ")");
  console.log("window: " + output.windowStart + " .. " + output.windowEnd);
  console.log("proof: " + output.proofBoundary);
  console.log(
    "reported-success=" + output.summary.reportedSuccess
    + " input=" + Math.round(output.summary.inputTokens)
    + " read=" + Math.round(output.summary.cacheReadTokens)
    + " (" + formatPercent(output.summary.cacheReadRatio) + ")"
    + " write=" + Math.round(output.summary.cacheWriteTokens)
    + " (" + formatPercent(output.summary.cacheWriteRatio) + ")",
  );
  console.log("");
  console.log("Top cohorts by measured input:");
  for (const item of output.cohorts) {
    console.log(
      item.signal.padEnd(11)
      + " " + item.adapter + "/" + item.provider + "/" + item.model
      + " surface=" + item.surface
      + " input=" + item.inputTokens
      + " read=" + formatPercent(item.cacheReadRatio)
      + " write=" + formatPercent(item.cacheWriteRatio)
      + " hits=" + formatPercent(item.cacheHitRequestRatio)
      + " n=" + item.reportedSuccess + "/" + item.requests,
    );
  }
  printCacheShapes(output.cacheShapes);
}

function printCacheShapes(shapes: readonly ShapeSummary[]): void {
  console.log("");
  if (shapes.length === 0) {
    console.log("No promptCache observations in this window (historical rows predate instrumentation).");
    return;
  }

  console.log("Observed outbound cache shapes:");
  for (const item of shapes) {
    console.log(
      item.adapter + "/" + item.provider + "/" + item.model
      + " surface=" + item.surface
      + " mode=" + item.mode
      + " tools=" + item.toolCount
      + " bp=" + item.breakpointCount
      + " input=" + item.inputTokens
      + " read=" + formatPercent(item.cacheReadRatio)
      + " write=" + formatPercent(item.cacheWriteRatio)
      + " n=" + item.reportedSuccess + "/" + item.requests
      + " prefix=" + (item.stablePrefixFingerprint ?? "-")
      + " toolsHash=" + (item.toolsFingerprint ?? "-"),
    );
  }
}

function main(): number {
  let options: AnalyzerOptions;
  try {
    options = parseArgs(Bun.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid arguments";
    console.error(message);
    console.error(usageText());
    return 2;
  }

  if (options.help) {
    console.log(usageText());
    return 0;
  }

  const since = sinceFor(options.range, options.nowMs);
  const parsed = parseUsageRows(readUsageSource(options));
  const selected = rowsInWindow(parsed.rows, since, options.nowMs);
  const output = buildOutput(
    options,
    since,
    selected.length,
    parsed.invalidLines,
    analyzeRows(selected),
  );

  if (options.jsonMode) {
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    return 0;
  }

  printHumanOutput(output);
  return 0;
}

process.exitCode = main();
