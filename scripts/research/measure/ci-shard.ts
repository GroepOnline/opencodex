#!/usr/bin/env bun
/**
 * CI shard measurement. Runs the repository's real `assignBalancedShards` on the real test file list and scores
 * the result against held-out per-file timings.
 *
 *   bun scripts/research/measure/ci-shard.ts [--shards N] [--timings path]
 *   bun scripts/research/measure/ci-shard.ts --collect [--limit N]    (maintainer: build the timings fixture)
 *
 * Output: { value: longestShardSeconds, details: { shardSeconds, imbalance, shardCount, files } }
 * The timings fixture is a local measurement kept under .tmp/ and never committed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assignBalancedShards, collectTestFiles, TEST_ROOT } from "../../ci-test-shard";
import { createIsolatedTestEnvironment } from "../../test";
import { REPO_ROOT, atomicWriteJson, imbalance, runCommand, shardTotals, validatePartition } from "../lib";

const DEFAULT_TIMINGS = join(".tmp", "research", "fixtures", "ci-timings.json");
const PER_FILE_TIMEOUT_MS = 120_000;

function option(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? undefined : Bun.argv[index + 1];
}

function integerOption(name: string, fallback: number): number {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

async function collect(): Promise<void> {
  const limit = integerOption("--limit", Number.MAX_SAFE_INTEGER);
  const files = (await collectTestFiles(TEST_ROOT)).sort((a, b) => a.path.localeCompare(b.path)).slice(0, limit);
  const seconds: Record<string, number> = {};
  const failed: string[] = [];
  for (const [index, file] of files.entries()) {
    const isolated = createIsolatedTestEnvironment();
    try {
      process.stderr.write(`[ci-shard] timing ${index + 1}/${files.length} ${file.path}\n`);
      const result = await runCommand(["bun", "test", "--isolate", `./${file.path}`], {
        cwd: REPO_ROOT,
        timeoutMs: PER_FILE_TIMEOUT_MS,
        env: isolated.env,
      });
      seconds[file.path] = Math.round(result.durationMs) / 1000;
      if (result.exitCode !== 0 || result.timedOut) failed.push(file.path);
    } finally {
      isolated.cleanup();
    }
  }
  const out = join(REPO_ROOT, option("--timings") ?? DEFAULT_TIMINGS);
  atomicWriteJson(out, { schema: 1, collectedAt: new Date().toISOString(), files: files.length, failed, seconds });
  process.stdout.write(`${JSON.stringify({ value: Object.values(seconds).reduce((a, b) => a + b, 0), details: { files: files.length, failed: failed.length } })}\n`);
}

async function measure(): Promise<void> {
  const shardCount = integerOption("--shards", 2);
  const timingsPath = join(REPO_ROOT, option("--timings") ?? DEFAULT_TIMINGS);
  let fixture: { schema?: number; seconds?: Record<string, number> };
  try {
    fixture = JSON.parse(readFileSync(timingsPath, "utf8"));
  } catch {
    throw new Error("timings fixture missing or unreadable; a maintainer must run `bun scripts/research/measure/ci-shard.ts --collect` first");
  }
  if (fixture.schema !== 1 || typeof fixture.seconds !== "object" || fixture.seconds === null) {
    throw new Error("timings fixture has an unexpected shape");
  }
  const files = await collectTestFiles(TEST_ROOT);
  if (files.length === 0) throw new Error("no test files found under tests/");
  // The assignment function only sees what CI sees: paths and byte sizes. Timings stay held out.
  const shards = assignBalancedShards(files.map((file) => ({ ...file })), shardCount);
  const problem = validatePartition(files, shards, shardCount);
  if (problem) throw new Error(`assignBalancedShards returned an invalid partition: ${problem}`);
  const totals = shardTotals(shards, fixture.seconds);
  const longest = Math.max(...totals);
  process.stdout.write(
    `${JSON.stringify({
      value: Math.round(longest * 1000) / 1000,
      details: { shardCount, files: files.length, shardSeconds: totals.map((t) => Math.round(t * 100) / 100), imbalance: Math.round(imbalance(totals) * 1000) / 1000 },
    })}\n`,
  );
}

try {
  await (Bun.argv.includes("--collect") ? collect() : measure());
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
