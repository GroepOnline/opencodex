#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type RangeName = "7d" | "30d" | "all";

interface CacheUsage {
  input: number;
  read: number;
  write: number;
}

interface Cohort {
  adapter: string;
  provider: string;
  model: string;
  surface: string;
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

interface ShapeSummary {
  shape: string;
  mode: string;
  ttl: string | null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cacheUsage(row: Record<string, unknown>): CacheUsage | undefined {
  if (row.status !== 200 || row.usageStatus !== "reported" || !isRecord(row.usage)) {
    return undefined;
  }
  const input = nonNegativeNumber(row.usage.inputTokens);
  if (input === undefined) return undefined;
  const write = nonNegativeNumber(row.usage.cacheCreationInputTokens) ?? 0;
  const explicitRead = nonNegativeNumber(row.usage.cacheReadInputTokens);
  const legacyCached = nonNegativeNumber(row.usage.cachedInputTokens);
  const read = explicitRead
    ?? (legacyCached !== undefined && row.usage.cacheCreationInputTokens !== undefined
      ? Math.max(0, legacyCached - write)
      : legacyCached)
    ?? 0;
  if (read + write > input) return undefined;
  return { input, read, write };
}

function parseRange(value: string | undefined): RangeName {
  return value === "7d" || value === "30d" || value === "all" ? value : "7d";
}

function sinceFor(range: RangeName, now: number): number {
  if (range === "all") return 0;
  return now - (range === "7d" ? 7 : 30) * 86_400_000;
}

function keyParts(row: Record<string, unknown>): [string, string, string, string] {
  const adapter = stringValue(row.adapter) ?? "unknown";
  const provider = stringValue(row.provider) ?? "unknown";
  const model = stringValue(row.resolvedModel) ?? stringValue(row.model) ?? "unknown";
  const surface = stringValue(row.surface) ?? "unknown";
  return [adapter, provider, model, surface];
}

function emptyCohort(parts: [string, string, string, string]): Cohort {
  return {
    adapter: parts[0],
    provider: parts[1],
    model: parts[2],
    surface: parts[3],
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

function signal(cohort: Cohort): string {
  const readRatio = ratio(cohort.cacheRead, cohort.input);
  const writeRatio = ratio(cohort.cacheWrite, cohort.input);
  if (writeRatio >= 0.5 && readRatio < 0.1) return "write-heavy";
  if (cohort.input >= 1_000_000 && readRatio < 0.25) return "low-reuse";
  if (readRatio >= 0.75) return "healthy";
  return "mixed";
}

function publicCohort(cohort: Cohort): Record<string, unknown> {
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

function cacheShapeKey(row: Record<string, unknown>): string | undefined {
  if (!isRecord(row.promptCache)) return undefined;
  const pc = row.promptCache;
  const parts = [
    stringValue(pc.mode) ?? "default",
    stringValue(pc.ttl) ?? "-",
    pc.keyPresent === true ? "key" : "nokey",
    String(nonNegativeNumber(pc.breakpointCount) ?? 0),
    stringValue(pc.toolsFingerprint) ?? "-",
    stringValue(pc.stablePrefixFingerprint) ?? "-",
    stringValue(pc.textFormatFingerprint) ?? "-",
    stringValue(pc.verbosity) ?? "-",
  ];
  return parts.join("|");
}

function shapeSummary(key: string, rows: Record<string, unknown>[]): ShapeSummary {
  const first = rows[0]?.promptCache;
  const pc = isRecord(first) ? first : {};
  let input = 0;
  let read = 0;
  let write = 0;
  let reportedSuccess = 0;
  for (const row of rows) {
    const usage = cacheUsage(row);
    if (!usage) continue;
    reportedSuccess += 1;
    input += usage.input;
    read += usage.read;
    write += usage.write;
  }
  return {
    shape: key,
    mode: stringValue(pc.mode) ?? "default",
    ttl: stringValue(pc.ttl) ?? null,
    keyPresent: pc.keyPresent === true,
    breakpointCount: nonNegativeNumber(pc.breakpointCount) ?? 0,
    toolCount: nonNegativeNumber(pc.toolCount) ?? 0,
    toolsFingerprint: stringValue(pc.toolsFingerprint) ?? null,
    stablePrefixFingerprint: stringValue(pc.stablePrefixFingerprint) ?? null,
    textFormatFingerprint: stringValue(pc.textFormatFingerprint) ?? null,
    verbosity: stringValue(pc.verbosity) ?? null,
    requests: rows.length,
    reportedSuccess,
    inputTokens: input,
    cacheReadTokens: read,
    cacheWriteTokens: write,
    cacheReadRatio: ratio(read, input),
    cacheWriteRatio: ratio(write, input),
  };
}

function formatPercent(value: unknown): string {
  return typeof value === "number" ? (value * 100).toFixed(1) + "%" : "-";
}

const args = Bun.argv.slice(2);
const source = args.find(arg => !arg.startsWith("--"))
  ?? join(process.env.OPENCODEX_HOME?.trim() || join(homedir(), ".opencodex"), "usage.jsonl");
const rangeArg = args.find(arg => arg.startsWith("--range="))?.slice("--range=".length);
const topArg = args.find(arg => arg.startsWith("--top="))?.slice("--top=".length);
const range = parseRange(rangeArg);
const top = Math.max(1, Math.min(200, Number.parseInt(topArg ?? "20", 10) || 20));
const jsonMode = args.includes("--json");
const now = Date.now();
const since = sinceFor(range, now);
const text = source === "-" ? readFileSync(0, "utf8") : readFileSync(source, "utf8");

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

const selected = rows.filter(row => {
  const timestamp = nonNegativeNumber(row.timestamp);
  return timestamp !== undefined && timestamp >= since;
});
const cohorts = new Map<string, Cohort>();
const shapeRows = new Map<string, Record<string, unknown>[]>();
let reportedSuccess = 0;
let input = 0;
let read = 0;
let write = 0;

for (const row of selected) {
  const parts = keyParts(row);
  const key = parts.join("\0");
  const cohort = cohorts.get(key) ?? emptyCohort(parts);
  cohorts.set(key, cohort);
  cohort.requests += 1;
  const conversationId = stringValue(row.conversationId);
  if (conversationId) {
    cohort.conversations.set(
      conversationId,
      (cohort.conversations.get(conversationId) ?? 0) + 1,
    );
  }

  const usage = cacheUsage(row);
  if (usage) {
    cohort.reportedSuccess += 1;
    cohort.input += usage.input;
    cohort.cacheRead += usage.read;
    cohort.cacheWrite += usage.write;
    cohort.uncachedInput += Math.max(0, usage.input - usage.read - usage.write);
    if (usage.read > 0) cohort.hitRequests += 1;
    if (usage.write > 0) cohort.writeRequests += 1;
    reportedSuccess += 1;
    input += usage.input;
    read += usage.read;
    write += usage.write;
  }

  const shape = cacheShapeKey(row);
  if (shape) {
    const compositeShape = [...parts, shape].join("\0");
    const existing = shapeRows.get(compositeShape);
    if (existing) existing.push(row);
    else shapeRows.set(compositeShape, [row]);
  }
}

const cohortOutput = [...cohorts.values()]
  .filter(cohort => cohort.reportedSuccess > 0)
  .sort((a, b) => b.input - a.input)
  .slice(0, top)
  .map(publicCohort);
const shapeOutput = [...shapeRows.entries()]
  .map(([key, value]) => shapeSummary(key.split("\0").slice(4).join("|"), value))
  .filter(shape => shape.reportedSuccess > 0)
  .sort((a, b) => b.inputTokens - a.inputTokens)
  .slice(0, top);

const output = {
  source: source === "-" ? "stdin" : source,
  range,
  rows: selected.length,
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
  cohorts: cohortOutput,
  cacheShapes: shapeOutput,
};

if (jsonMode) {
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  process.exit(0);
}

console.log("Prompt cache usage (" + range + ")");
console.log("proof: " + output.proofBoundary);
console.log(
  "reported-success=" + reportedSuccess
  + " input=" + Math.round(input)
  + " read=" + Math.round(read) + " (" + formatPercent(output.summary.cacheReadRatio) + ")"
  + " write=" + Math.round(write) + " (" + formatPercent(output.summary.cacheWriteRatio) + ")",
);
console.log("");
console.log("Top cohorts by measured input:");
for (const item of cohortOutput) {
  console.log(
    String(item.signal).padEnd(11)
    + " " + String(item.adapter) + "/" + String(item.provider) + "/" + String(item.model)
    + " surface=" + String(item.surface)
    + " input=" + String(item.inputTokens)
    + " read=" + formatPercent(item.cacheReadRatio)
    + " write=" + formatPercent(item.cacheWriteRatio)
    + " hits=" + formatPercent(item.cacheHitRequestRatio)
    + " n=" + String(item.reportedSuccess) + "/" + String(item.requests),
  );
}
if (shapeOutput.length > 0) {
  console.log("");
  console.log("Observed outbound cache shapes:");
  for (const item of shapeOutput) {
    console.log(
      item.mode.padEnd(8)
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
} else {
  console.log("");
  console.log("No promptCache observations in this window (historical rows predate instrumentation).");
}
