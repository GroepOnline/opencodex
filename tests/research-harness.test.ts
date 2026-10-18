import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALWAYS_FROZEN,
  atomicWriteJson,
  changePct,
  decideVerdict,
  findBoundaryViolations,
  findForbiddenReferences,
  hashFiles,
  imbalance,
  loadTarget,
  median,
  parseMeasurement,
  parseTargetConfig,
  pathMatches,
  shardTotals,
  spreadPct,
  validatePartition,
  REPO_ROOT,
} from "../scripts/research/lib";

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "research-harness-test-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("statistics and verdicts", () => {
  test("median and spread", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(() => median([])).toThrow();
    expect(spreadPct([100])).toBe(0);
    expect(spreadPct([90, 100, 110])).toBeCloseTo(20, 5);
  });

  test("changePct is positive for improvements in either direction", () => {
    expect(changePct(100, 80, "lower")).toBeCloseTo(20, 5);
    expect(changePct(0.5, 0.6, "higher")).toBeCloseTo(20, 5);
    expect(changePct(100, 120, "lower")).toBeCloseTo(-20, 5);
    expect(() => changePct(0, 1, "lower")).toThrow();
  });

  test("verdict must beat both the minimum and the observed noise", () => {
    const base = { baselineMedian: 100, baselineSpreadPct: 2, currentSpreadPct: 2, direction: "lower" as const, minImprovementPct: 3 };
    expect(decideVerdict({ ...base, currentMedian: 90 }).verdict).toBe("improved");
    expect(decideVerdict({ ...base, currentMedian: 98 }).verdict).toBe("no-change");
    expect(decideVerdict({ ...base, currentMedian: 110 }).verdict).toBe("regressed");
    // A 5% gain is not real when the runs themselves wobble by 8%.
    expect(decideVerdict({ ...base, currentSpreadPct: 8, currentMedian: 95 }).verdict).toBe("no-change");
    expect(decideVerdict({ ...base, currentMedian: 90 }).thresholdPct).toBe(3);
  });
});

describe("measurement parsing", () => {
  test("reads the last JSON line and ignores earlier noise", () => {
    const parsed = parseMeasurement('warming up\n{"value": 12.5, "details": {"a": 1}}\n');
    expect(parsed).toEqual({ value: 12.5, details: { a: 1 } });
  });
  test("rejects non-JSON, non-objects, and non-finite values", () => {
    expect(() => parseMeasurement("")).toThrow();
    expect(() => parseMeasurement("hello")).toThrow();
    expect(() => parseMeasurement("[1]")).toThrow();
    expect(() => parseMeasurement('{"value": "fast"}')).toThrow();
    expect(() => parseMeasurement('{"value": null}')).toThrow();
  });
});

describe("path boundaries", () => {
  test("directory prefixes and exact files", () => {
    expect(pathMatches("src/a/b.ts", "src/")).toBe(true);
    expect(pathMatches("srcx/a.ts", "src/")).toBe(false);
    expect(pathMatches("scripts/ci-test-shard.ts", "scripts/ci-test-shard.ts")).toBe(true);
    expect(pathMatches("scripts\\ci-test-shard.ts", "./scripts/ci-test-shard.ts")).toBe(true);
  });

  test("frozen wins over mutable and everything else is outside", () => {
    const violations = findBoundaryViolations(
      ["src/x.ts", "scripts/research/lib.ts", ".github/workflows/ci.yml", "docs/a.md", "package.json"],
      ["src/", "docs/"],
    );
    expect(violations).toEqual([
      { path: "scripts/research/lib.ts", reason: "frozen" },
      { path: ".github/workflows/ci.yml", reason: "frozen" },
      { path: "package.json", reason: "frozen" },
    ]);
    expect(findBoundaryViolations(["other/x.ts"], ["src/"])).toEqual([{ path: "other/x.ts", reason: "outside-mutable" }]);
  });
});

describe("target configs", () => {
  test("every shipped target parses and keeps release tooling frozen", () => {
    const dir = join(REPO_ROOT, "scripts", "research", "targets");
    const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const config = loadTarget(REPO_ROOT, file.replace(/\.json$/, ""));
      for (const entry of config.mutable) {
        for (const frozen of ALWAYS_FROZEN) expect(pathMatches(entry, frozen)).toBe(false);
      }
      expect(config.guards.length).toBeGreaterThan(0);
    }
  });

  test("rejects mutable paths that overlap the frozen set and bad ids", () => {
    const good = JSON.parse(readFileSync(join(REPO_ROOT, "scripts", "research", "targets", "cold-start.json"), "utf8"));
    expect(() => parseTargetConfig({ ...good, mutable: [".github/"] })).toThrow(/always-frozen/);
    expect(() => parseTargetConfig({ ...good, mutable: ["scripts/"] })).toThrow(/always-frozen/);
    expect(() => parseTargetConfig({ ...good, minImprovementPct: 0 })).toThrow();
    expect(() => parseTargetConfig(good, "other-id")).toThrow();
    expect(() => loadTarget(REPO_ROOT, "../etc/passwd")).toThrow(/invalid target id/);
  });
});

describe("file helpers", () => {
  test("atomicWriteJson replaces content and leaves no temp files", () => {
    const dir = tempDir();
    const file = join(dir, "nested", "state.json");
    atomicWriteJson(file, { a: 1 });
    atomicWriteJson(file, { a: 2 });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ a: 2 });
    expect(readdirSync(join(dir, "nested"))).toEqual(["state.json"]);
  });

  test("hashFiles changes with content, ignores listing order, and names missing fixtures", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.json"), "1");
    writeFileSync(join(dir, "b.json"), "2");
    const first = hashFiles(dir, ["a.json", "b.json"]);
    expect(hashFiles(dir, ["b.json", "a.json"])).toBe(first);
    writeFileSync(join(dir, "b.json"), "3");
    expect(hashFiles(dir, ["a.json", "b.json"])).not.toBe(first);
    expect(() => hashFiles(dir, ["missing.json"])).toThrow(/fixture missing: missing.json/);
  });

  test("findForbiddenReferences flags held-out fixture and harness references", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "ok.ts"), "export const x = 1;");
    writeFileSync(join(dir, "leak.ts"), 'readFileSync(".tmp/research/fixtures/ci-timings.json")');
    expect(findForbiddenReferences(dir, ["ok.ts", "leak.ts", "gone.ts"], [".tmp/research"])).toEqual([
      { path: "leak.ts", needle: ".tmp/research" },
    ]);
    expect(findForbiddenReferences(dir, ["leak.ts"], [])).toEqual([]);
  });
});

describe("shard partition checks", () => {
  const files = [
    { path: "tests/a.test.ts", bytes: 10 },
    { path: "tests/b.test.ts", bytes: 20 },
    { path: "tests/c.test.ts", bytes: 30 },
  ];

  test("accepts an exact partition", () => {
    expect(validatePartition(files, [[files[0]!, files[2]!], [files[1]!]], 2)).toBeNull();
  });

  test("rejects wrong shard counts, drops, duplicates, and inventions", () => {
    expect(validatePartition(files, [files], 2)).toMatch(/expected 2 shards/);
    expect(validatePartition(files, [[files[0]!], [files[1]!]], 2)).toMatch(/missing from shards: tests\/c.test.ts/);
    expect(validatePartition(files, [[files[0]!, files[1]!], [files[1]!, files[2]!]], 2)).toMatch(/assigned 2 times/);
    expect(validatePartition(files, [[...files], [{ path: "tests/new.test.ts", bytes: 1 }]], 2)).toMatch(/unknown file/);
  });

  test("totals use held-out timings and fail loudly on gaps", () => {
    const seconds = { "tests/a.test.ts": 1, "tests/b.test.ts": 2, "tests/c.test.ts": 4 };
    expect(shardTotals([[files[0]!, files[2]!], [files[1]!]], seconds)).toEqual([5, 2]);
    expect(() => shardTotals([[files[0]!]], { "tests/a.test.ts": Number.NaN })).toThrow(/no valid timing/);
    expect(() => shardTotals([[files[0]!]], {})).toThrow(/no valid timing/);
  });

  test("imbalance is max over mean", () => {
    expect(imbalance([5, 5])).toBe(1);
    expect(imbalance([6, 2])).toBe(1.5);
    expect(imbalance([0, 0])).toBe(1);
  });
});
