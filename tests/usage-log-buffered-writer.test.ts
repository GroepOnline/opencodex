import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendUsageEntry,
  flushUsageLog,
  readUsageEntries,
  resetUsageReadCacheForTests,
  subscribeUsageAppends,
  usageLogPath,
  usageLogWriterStatsForTests,
  type PersistedUsageEntry,
  type UsageAppendObservation,
} from "../src/usage/log";

let testDir = "";
let previousHome: string | undefined;
const cleanups: Array<() => void> = [];

function entry(requestId: string): PersistedUsageEntry {
  return {
    requestId,
    timestamp: 1,
    provider: "openai",
    model: "gpt-5.5",
    status: 200,
    durationMs: 1,
    usageStatus: "reported",
    usage: { inputTokens: 1, outputTokens: 1 },
    totalTokens: 2,
  };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-usage-buffered-"));
  process.env.OPENCODEX_HOME = testDir;
  // Drains rows queued by earlier tests to their own captured paths and leaves
  // the buffer empty so bufferedRows assertions stay deterministic.
  resetUsageReadCacheForTests();
});

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("buffered usage.jsonl writer", () => {
  test("append queues; a flush persists the row and notifies observers once", () => {
    const seen: UsageAppendObservation[] = [];
    cleanups.push(
      subscribeUsageAppends((observation) => seen.push(observation)),
    );

    appendUsageEntry(entry("buffered-1"));
    expect(existsSync(usageLogPath())).toBe(false);
    expect(seen).toHaveLength(0);

    flushUsageLog();
    expect(
      readFileSync(usageLogPath(), "utf8").trim().split("\n"),
    ).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ status: 200, durationMs: 1 });
  });

  test("read entry points observe their own writes without an explicit flush", () => {
    appendUsageEntry(entry("read-your-writes"));
    expect(readUsageEntries().map((row) => row.requestId)).toEqual([
      "read-your-writes",
    ]);
  });

  test("reaching the row threshold flushes synchronously without a timer", () => {
    for (let index = 0; index < 64; index += 1)
      appendUsageEntry(entry(`bulk-${index}`));
    expect(usageLogWriterStatsForTests().bufferedRows).toBe(0);
    expect(
      readFileSync(usageLogPath(), "utf8").trim().split("\n"),
    ).toHaveLength(64);
  });

  test("a broken sink never throws on the append path; loss is counted, recovery lands", () => {
    const seen: UsageAppendObservation[] = [];
    cleanups.push(
      subscribeUsageAppends((observation) => seen.push(observation)),
    );
    // Occupy the log path with a directory so the batched write fails (EISDIR).
    mkdirSync(usageLogPath(), { recursive: true });
    const droppedBefore = usageLogWriterStatsForTests().droppedRows;

    expect(() => appendUsageEntry(entry("dropped-1"))).not.toThrow();
    expect(() => flushUsageLog()).not.toThrow();
    // A failed batch emits no observation and does not stay queued forever.
    expect(seen).toHaveLength(0);
    expect(usageLogWriterStatsForTests().writeFailures).toBeGreaterThan(0);
    expect(usageLogWriterStatsForTests().droppedRows).toBe(droppedBefore + 1);
    expect(usageLogWriterStatsForTests().bufferedRows).toBe(0);

    // Recovery: the next append writes normally and notifies exactly once.
    rmSync(usageLogPath(), { recursive: true, force: true });
    appendUsageEntry(entry("recovered-1"));
    flushUsageLog();
    expect(seen).toHaveLength(1);
    expect(readUsageEntries().map((row) => row.requestId)).toEqual([
      "recovered-1",
    ]);
  });
});
