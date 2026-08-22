import { describe, expect, mock, test } from "bun:test";
import type { PersistedUsageEntry } from "../src/usage/log";

const readRecentUsageEntries = mock(() => [] as PersistedUsageEntry[]);
mock.module("../src/usage/log", () => ({
  readRecentUsageEntries: (...args: unknown[]) => readRecentUsageEntries(...args),
}));

const { p50DurationForModel } = await import("../src/usage/latency-history");

function entriesFor(bucketStartMs: number): PersistedUsageEntry[] {
  return [
    { provider: "p1", model: "m1", durationMs: 100, timestamp: bucketStartMs + 1_000 },
    { provider: "p1", model: "m1", durationMs: 300, timestamp: bucketStartMs + 2_000 },
  ] as unknown as PersistedUsageEntry[];
}

describe("p50DurationForModel window cache", () => {
  test("reuses the sample cache across requests whose sinceMs differs but shares a minute bucket", () => {
    readRecentUsageEntries.mockReset();
    const t0 = Date.UTC(2026, 7, 22, 10, 0, 0);
    readRecentUsageEntries.mockImplementation(() => entriesFor(t0 - 60_000));

    // Two auto-router requests a few seconds apart derive sinceMs = now - windowMs, so the
    // raw values differ. Both must hit one cache build within the TTL.
    const now = t0 + 5_000;
    const first = p50DurationForModel("p1", "m1", now - 60_000, now);
    const second = p50DurationForModel("p1", "m1", (now + 4_000) - 60_000, now + 4_000);

    expect(first).toBe(200);
    expect(second).toBe(200);
    expect(readRecentUsageEntries).toHaveBeenCalledTimes(1);
  });

  test("rebuilds when the window falls in a different minute bucket", () => {
    readRecentUsageEntries.mockReset();
    const t0 = Date.UTC(2026, 7, 22, 11, 0, 0);
    readRecentUsageEntries.mockImplementation(() => entriesFor(t0 - 60_000));

    const now = t0 + 5_000;
    p50DurationForModel("p1", "m1", now - 60_000, now);
    // A window a full minute away lands in another bucket: the aggregated samples cannot
    // answer it, so the cache must rebuild.
    p50DurationForModel("p1", "m1", now - 180_000, now);

    expect(readRecentUsageEntries).toHaveBeenCalledTimes(2);
  });
});
