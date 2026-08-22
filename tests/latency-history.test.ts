import { describe, expect, spyOn, test } from "bun:test";
import * as usageLog from "../src/usage/log";
import type { PersistedUsageEntry } from "../src/usage/log";
import { p50DurationForModel } from "../src/usage/latency-history";

const readRecentUsageEntries = spyOn(usageLog, "readRecentUsageEntries");

function entriesFor(bucketStartMs: number): PersistedUsageEntry[] {
  return [
    { provider: "p1", model: "m1", durationMs: 100, timestamp: bucketStartMs + 1_000 },
    { provider: "p1", model: "m1", durationMs: 300, timestamp: bucketStartMs + 2_000 },
  ] as unknown as PersistedUsageEntry[];
}

describe("p50DurationForModel window cache", () => {
  test("reuses the sample cache across requests with the same window duration inside the TTL", () => {
    readRecentUsageEntries.mockReset();
    const t0 = Date.UTC(2026, 7, 22, 10, 0, 0);
    readRecentUsageEntries.mockImplementation(() => entriesFor(t0 - 50_000));

    const now = t0 + 5_000;
    const first = p50DurationForModel("p1", "m1", now - 60_000, now);
    const second = p50DurationForModel("p1", "m1", (now + 4_000) - 60_000, now + 4_000);

    expect(first).toBe(200);
    expect(second).toBe(200);
    expect(readRecentUsageEntries).toHaveBeenCalledTimes(1);
  });

  test("filters samples against the exact requested sinceMs", () => {
    readRecentUsageEntries.mockReset();
    const t0 = Date.UTC(2026, 7, 22, 10, 30, 0);
    readRecentUsageEntries.mockImplementation(() => [
      { provider: "p1", model: "m1", durationMs: 999, timestamp: t0 - 59_000 },
      { provider: "p1", model: "m1", durationMs: 100, timestamp: t0 - 49_000 },
      { provider: "p1", model: "m1", durationMs: 300, timestamp: t0 - 48_000 },
    ] as unknown as PersistedUsageEntry[]);

    expect(p50DurationForModel("p1", "m1", t0 - 50_000, t0)).toBe(200);
  });

  test("rebuilds when the window falls in a different duration bucket", () => {
    readRecentUsageEntries.mockReset();
    const t0 = Date.UTC(2026, 7, 22, 11, 0, 0);
    readRecentUsageEntries.mockImplementation(() => entriesFor(t0 - 60_000));

    const now = t0 + 5_000;
    p50DurationForModel("p1", "m1", now - 60_000, now);
    p50DurationForModel("p1", "m1", now - 180_000, now);

    expect(readRecentUsageEntries).toHaveBeenCalledTimes(2);
  });
});
