#!/usr/bin/env bun
/**
 * Prompt-cache characterization (analysis only). Runs the existing analyzer over a local, anonymized usage log
 * and reports the aggregate cacheReadRatio plus the weakest cohorts.
 *
 * This describes recorded traffic. It cannot score a code change, because replaying a fixed log never exercises
 * the changed request builder. Turning this into an eval needs a prefix-cache simulator over recorded request
 * shapes; until then the target is analysis-only and `baseline`/`run` refuse it.
 *
 *   bun scripts/research/measure/prompt-cache.ts [--usage path]
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, runCommand } from "../lib";

const DEFAULT_USAGE = join(".tmp", "research", "fixtures", "usage.jsonl");

interface Analyzer {
  rows: number;
  summary: { reportedSuccess: number; inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheReadRatio: number };
  cohorts: { adapter: string; provider: string; model: string; signal: string; requests: number; cacheReadRatio: number }[];
}

const index = Bun.argv.indexOf("--usage");
const usage = index === -1 ? DEFAULT_USAGE : Bun.argv[index + 1];
try {
  if (!usage) throw new Error("--usage needs a path");
  const abs = join(REPO_ROOT, usage);
  // Anchor the analysis window to the file itself so the result is reproducible.
  const now = Math.trunc(statSync(abs).mtimeMs);
  const result = await runCommand(
    ["bun", "scripts/analyze-prompt-cache-usage.ts", usage, "--range=all", `--now=${now}`, "--json"],
    { cwd: REPO_ROOT, timeoutMs: 120_000 },
  );
  if (result.exitCode !== 0) throw new Error(`analyzer exited ${result.exitCode}: ${result.stderr.trim().split("\n").slice(-2).join(" | ")}`);
  const out = JSON.parse(result.stdout) as Analyzer;
  const weakest = [...out.cohorts]
    .sort((a, b) => a.cacheReadRatio - b.cacheReadRatio)
    .slice(0, 5)
    .map((c) => ({ adapter: c.adapter, provider: c.provider, model: c.model, signal: c.signal, requests: c.requests, cacheReadRatio: c.cacheReadRatio }));
  process.stdout.write(`${JSON.stringify({ value: out.summary.cacheReadRatio, details: { rows: out.rows, reportedSuccess: out.summary.reportedSuccess, inputTokens: out.summary.inputTokens, cacheReadTokens: out.summary.cacheReadTokens, cacheWriteTokens: out.summary.cacheWriteTokens, weakestCohorts: weakest } })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
