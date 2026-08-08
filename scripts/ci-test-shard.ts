import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { createIsolatedTestEnvironment } from "./test";

export const TEST_ROOT = resolve("tests");
const TEST_FILE = /(?:\.test\.|\.spec\.|_test\.|_spec\.)(?:[cm]?[jt]sx?)$/i;
const BATCH_SIZE = 80;

export interface TestFile {
  path: string;
  bytes: number;
}

export async function collectTestFiles(directory: string): Promise<TestFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: TestFile[] = [];

  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTestFiles(absolute));
      continue;
    }
    if (!entry.isFile() || !TEST_FILE.test(entry.name)) continue;
    const metadata = await stat(absolute);
    files.push({
      path: relative(process.cwd(), absolute).split(sep).join("/"),
      bytes: metadata.size,
    });
  }

  return files;
}

export function parseInteger(value: string | undefined, name: string): number {
  // Number("") coerces to 0, so a blank matrix value must be rejected explicitly.
  const parsed = value === undefined || value.trim() === "" ? Number.NaN : Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer; got ${value ?? "<missing>"}`);
  return parsed;
}

export interface ShardSelection {
  shardIndex: number;
  shardCount: number;
}

export function parseShardSelection(
  shardIndexRaw: string | undefined,
  shardCountRaw: string | undefined,
): ShardSelection {
  const shardIndex = parseInteger(shardIndexRaw, "shardIndex");
  const shardCount = parseInteger(shardCountRaw, "shardCount");
  if (shardCount < 1) throw new Error("shardCount must be at least 1");
  if (shardIndex < 0 || shardIndex >= shardCount) {
    throw new Error(`shardIndex must be between 0 and ${shardCount - 1}; got ${shardIndex}`);
  }
  return { shardIndex, shardCount };
}

export function assignBalancedShards(files: TestFile[], shardCount: number): TestFile[][] {
  const shards = Array.from({ length: shardCount }, () => [] as TestFile[]);
  const totals = Array.from({ length: shardCount }, () => 0);

  // File size is a stable, repository-local proxy for test cost. Greedy assignment avoids the
  // severe imbalance produced by alphabetical modulo sharding while remaining deterministic.
  const ordered = [...files].sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path));
  for (const file of ordered) {
    let target = 0;
    for (let index = 1; index < shardCount; index += 1) {
      if (totals[index]! < totals[target]!) target = index;
    }
    shards[target]!.push(file);
    totals[target] += file.bytes;
  }

  for (const shard of shards) shard.sort((left, right) => left.path.localeCompare(right.path));
  return shards;
}

async function runBatch(paths: string[], env: Record<string, string | undefined>): Promise<number> {
  // Match the canonical scripts/test.ts orchestration: spawn the current Bun binary and run
  // against an isolated HOME so shards never read or mutate the runner's real configuration.
  // Bun treats bare positional test arguments as substring filters; a "./" prefix forces each
  // argument to be resolved as an exact file path so a batch never pulls in unrelated tests.
  const child = Bun.spawn([process.execPath, "test", "--isolate", ...paths.map(path => `./${path}`)], {
    cwd: process.cwd(),
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
}

async function main(): Promise<void> {
  const { shardIndex, shardCount } = parseShardSelection(Bun.argv[2], Bun.argv[3]);

  const files = await collectTestFiles(TEST_ROOT);
  if (files.length === 0) throw new Error("No Bun test files found under tests/");

  const shards = assignBalancedShards(files, shardCount);
  const selected = shards[shardIndex]!;
  const totalBytes = selected.reduce((sum, file) => sum + file.bytes, 0);
  console.log(
    `[ci-test-shard] shard ${shardIndex + 1}/${shardCount}: ${selected.length}/${files.length} files, ${totalBytes} source bytes`,
  );

  const isolated = createIsolatedTestEnvironment();
  try {
    for (let offset = 0; offset < selected.length; offset += BATCH_SIZE) {
      const batch = selected.slice(offset, offset + BATCH_SIZE).map(file => file.path);
      console.log(`[ci-test-shard] batch ${Math.floor(offset / BATCH_SIZE) + 1}: ${batch.length} files`);
      const exitCode = await runBatch(batch, isolated.env);
      if (exitCode !== 0) {
        process.exitCode = exitCode;
        return;
      }
    }
  } finally {
    isolated.cleanup();
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
