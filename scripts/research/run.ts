#!/usr/bin/env bun
/**
 * Offline autoresearch harness CLI. Prints exactly one JSON object on stdout; progress goes to stderr.
 *
 *   bun scripts/research/run.ts list
 *   bun scripts/research/run.ts measure  --target <id> [--runs N]   quick look, no verdict, no guards
 *   bun scripts/research/run.ts baseline --target <id>              record the reference measurement
 *   bun scripts/research/run.ts run      --target <id>              boundaries, guards, measure, verdict
 */
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXIT,
  REPO_ROOT,
  atomicWriteJson,
  decideVerdict,
  findBoundaryViolations,
  findForbiddenReferences,
  gitChangedPaths,
  gitHeadSha,
  hashFiles,
  loadTarget,
  median,
  parseMeasurement,
  parseTargetConfig,
  runCommand,
  spreadPct,
  stateDir,
  type Measurement,
  type TargetConfig,
} from "./lib";

const GUARD_TIMEOUT_MS = 30 * 60 * 1000;

interface Baseline {
  schema: 1;
  target: string;
  createdAt: string;
  headSha: string;
  fixtureHash: string;
  metric: TargetConfig["metric"];
  values: number[];
  median: number;
  spreadPct: number;
  details: Record<string, unknown>;
}

function log(message: string): void {
  process.stderr.write(`[research] ${message}\n`);
}

function emit(payload: unknown, exitCode: number): never {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(exitCode);
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function measureOnce(target: TargetConfig): Promise<Measurement> {
  const result = await runCommand(target.measure, { cwd: REPO_ROOT, timeoutMs: target.timeoutMs });
  if (result.timedOut) throw new Error(`measurement timed out after ${target.timeoutMs} ms`);
  if (result.exitCode !== 0) {
    throw new Error(`measurement exited ${result.exitCode}: ${result.stderr.trim().split("\n").slice(-5).join(" | ")}`);
  }
  return parseMeasurement(result.stdout);
}

async function measureRuns(target: TargetConfig, runs: number): Promise<{ values: number[]; last: Measurement }> {
  const values: number[] = [];
  let last: Measurement | undefined;
  for (let index = 0; index < runs; index += 1) {
    log(`${target.id}: measuring ${index + 1}/${runs}`);
    last = await measureOnce(target);
    values.push(last.value);
  }
  return { values, last: last! };
}

function requireReady(target: TargetConfig, command: string): void {
  if (target.status !== "ready") {
    throw new Error(`target ${target.id} is ${target.status}; \`${command}\` needs a ready target. ${target.notes ?? ""}`.trim());
  }
}

function listTargets(): never {
  const dir = join(REPO_ROOT, "scripts", "research", "targets");
  const targets = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const config = parseTargetConfig(JSON.parse(readFileSync(join(dir, name), "utf8")), name.replace(/\.json$/, ""));
      return { id: config.id, status: config.status, metric: config.metric, description: config.description };
    });
  return emit({ targets }, EXIT.improved);
}

async function commandMeasure(target: TargetConfig, runs: number): Promise<never> {
  if (target.status === "blocked") throw new Error(`target ${target.id} is blocked. ${target.notes ?? ""}`.trim());
  const { values, last } = await measureRuns(target, runs);
  return emit(
    { target: target.id, metric: target.metric, values, median: median(values), spreadPct: spreadPct(values), details: last.details },
    EXIT.improved,
  );
}

async function commandBaseline(target: TargetConfig): Promise<never> {
  requireReady(target, "baseline");
  const head = await gitHeadSha(REPO_ROOT);
  const dirty = await gitChangedPaths(REPO_ROOT, head);
  if (dirty.length > 0) {
    throw new Error(`working tree has uncommitted changes (${dirty.slice(0, 5).join(", ")}); commit or stash before recording a baseline`);
  }
  const fixtureHash = hashFiles(REPO_ROOT, target.fixtures);
  const { values, last } = await measureRuns(target, target.runs);
  const baseline: Baseline = {
    schema: 1,
    target: target.id,
    createdAt: new Date().toISOString(),
    headSha: head,
    fixtureHash,
    metric: target.metric,
    values,
    median: median(values),
    spreadPct: spreadPct(values),
    details: last.details,
  };
  atomicWriteJson(join(stateDir(REPO_ROOT, target.id), "baseline.json"), baseline);
  return emit({ target: target.id, baseline }, EXIT.improved);
}

async function commandRun(target: TargetConfig): Promise<never> {
  requireReady(target, "run");
  const file = join(stateDir(REPO_ROOT, target.id), "baseline.json");
  if (!existsSync(file)) throw new Error(`no baseline for ${target.id}; run \`baseline\` first`);
  const baseline = JSON.parse(readFileSync(file, "utf8")) as Baseline;
  const base = { target: target.id, metric: target.metric, baselineHeadSha: baseline.headSha };

  const changed = await gitChangedPaths(REPO_ROOT, baseline.headSha);
  const boundary = findBoundaryViolations(changed, target.mutable);
  const forbidden = findForbiddenReferences(
    REPO_ROOT,
    changed.filter((path) => !boundary.some((v) => v.path === path)),
    target.forbiddenInMutable,
  );
  const fixtureHash = hashFiles(REPO_ROOT, target.fixtures);
  const fixturesChanged = fixtureHash !== baseline.fixtureHash;
  if (boundary.length > 0 || forbidden.length > 0 || fixturesChanged) {
    return emit(
      { ...base, verdict: "guard-failed", changedPaths: changed, boundaryViolations: boundary, forbiddenReferences: forbidden, fixturesChanged },
      EXIT.guardFailed,
    );
  }

  const guards: { command: string; exitCode: number | null; ok: boolean; timedOut: boolean }[] = [];
  for (const argv of target.guards) {
    log(`guard: ${argv.join(" ")}`);
    const result = await runCommand(argv, { cwd: REPO_ROOT, timeoutMs: GUARD_TIMEOUT_MS });
    const ok = result.exitCode === 0 && !result.timedOut;
    guards.push({ command: argv.join(" "), exitCode: result.exitCode, ok, timedOut: result.timedOut });
    if (!ok) {
      return emit({ ...base, verdict: "guard-failed", changedPaths: changed, guards }, EXIT.guardFailed);
    }
  }

  const { values, last } = await measureRuns(target, target.runs);
  const currentMedian = median(values);
  const currentSpread = spreadPct(values);
  const decision = decideVerdict({
    baselineMedian: baseline.median,
    baselineSpreadPct: baseline.spreadPct,
    currentMedian,
    currentSpreadPct: currentSpread,
    direction: target.metric.direction,
    minImprovementPct: target.minImprovementPct,
  });
  const exitCode =
    decision.verdict === "improved" ? EXIT.improved : decision.verdict === "regressed" ? EXIT.regressed : EXIT.noChange;
  return emit(
    {
      ...base,
      verdict: decision.verdict,
      changePct: Number(decision.changePct.toFixed(2)),
      thresholdPct: Number(decision.thresholdPct.toFixed(2)),
      baseline: { median: baseline.median, spreadPct: baseline.spreadPct, values: baseline.values },
      current: { median: currentMedian, spreadPct: currentSpread, values, details: last.details },
      guards,
      changedPaths: changed,
    },
    exitCode,
  );
}

async function main(): Promise<void> {
  const [command, ...args] = Bun.argv.slice(2);
  try {
    if (command === "list") return listTargets();
    const id = flag(args, "--target");
    if (!command || !["measure", "baseline", "run"].includes(command) || !id) {
      throw new Error("usage: run.ts <list | measure | baseline | run> --target <id> [--runs N]");
    }
    const target = loadTarget(REPO_ROOT, id);
    if (command === "measure") {
      const runs = flag(args, "--runs") === undefined ? 1 : Number(flag(args, "--runs"));
      if (!Number.isInteger(runs) || runs < 1 || runs > 25) throw new Error("--runs must be an integer 1..25");
      return await commandMeasure(target, runs);
    }
    if (command === "baseline") return await commandBaseline(target);
    return await commandRun(target);
  } catch (error) {
    emit({ error: error instanceof Error ? error.message : String(error) }, EXIT.error);
  }
}

await main();
