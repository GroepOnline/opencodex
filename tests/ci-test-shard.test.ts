import { describe, expect, test } from "bun:test";

import {
  assignBalancedShards,
  collectTestFiles,
  parseInteger,
  parseShardSelection,
  TEST_ROOT,
  type TestFile,
} from "../scripts/ci-test-shard";

// CI relies on the shard partitioner to run every root test exactly once across the configured
// shard invocations (Windows currently uses two). A regression in discovery, path normalization,
// or assignment would silently skip or duplicate tests on the sharded platforms only, so pin the
// coverage invariant here where the full suite catches it on every platform.
describe("ci-test-shard partition invariants", () => {
  const shardCounts = [1, 2, 3, 4];

  test("discovers this test file among the root tests", async () => {
    const files = await collectTestFiles(TEST_ROOT);
    expect(files.map(file => file.path)).toContain("tests/ci-test-shard.test.ts");
  });

  test.each(shardCounts)("%i shard(s) cover every discovered test exactly once", async shardCount => {
    const files = await collectTestFiles(TEST_ROOT);
    expect(files.length).toBeGreaterThan(0);

    const shards = assignBalancedShards(files, shardCount);
    expect(shards.length).toBe(shardCount);

    const union = shards.flat().map(file => file.path);
    expect(union.length).toBe(files.length);
    expect(new Set(union).size).toBe(union.length);
    expect([...union].sort()).toEqual(files.map(file => file.path).sort());
  });

  test("assignment is deterministic regardless of discovery order", () => {
    const files: TestFile[] = [
      { path: "tests/a.test.ts", bytes: 500 },
      { path: "tests/b.test.ts", bytes: 300 },
      { path: "tests/c.test.ts", bytes: 300 },
      { path: "tests/d.test.ts", bytes: 100 },
    ];
    const shuffled = [files[2]!, files[0]!, files[3]!, files[1]!];

    const fromOrdered = assignBalancedShards(files, 2).map(shard => shard.map(file => file.path));
    const fromShuffled = assignBalancedShards(shuffled, 2).map(shard => shard.map(file => file.path));
    expect(fromShuffled).toEqual(fromOrdered);
  });
});

// A misconfigured CI matrix (missing, malformed, or out-of-range shard arguments) must fail loudly
// instead of silently running the wrong slice of the suite, so pin the CLI validation branches.
describe("ci-test-shard argument validation", () => {
  test("parseInteger rejects missing values", () => {
    expect(() => parseInteger(undefined, "shardIndex")).toThrow("shardIndex must be an integer; got <missing>");
  });

  test.each(["", " ", "two", "1.5", "NaN"])("parseInteger rejects non-integer value %j", value => {
    expect(() => parseInteger(value, "shardCount")).toThrow(/shardCount must be an integer/);
  });

  test("parseInteger accepts integer strings", () => {
    expect(parseInteger("0", "shardIndex")).toBe(0);
    expect(parseInteger("3", "shardCount")).toBe(3);
  });

  test("parseShardSelection rejects shardCount below 1", () => {
    expect(() => parseShardSelection("0", "0")).toThrow("shardCount must be at least 1");
    expect(() => parseShardSelection("0", "-2")).toThrow("shardCount must be at least 1");
  });

  test("parseShardSelection rejects out-of-range shardIndex", () => {
    expect(() => parseShardSelection("-1", "2")).toThrow("shardIndex must be between 0 and 1; got -1");
    expect(() => parseShardSelection("2", "2")).toThrow("shardIndex must be between 0 and 1; got 2");
  });

  test("parseShardSelection accepts a valid in-range configuration", () => {
    expect(parseShardSelection("1", "2")).toEqual({ shardIndex: 1, shardCount: 2 });
  });
});
