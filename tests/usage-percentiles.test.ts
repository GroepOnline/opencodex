import { describe, expect, it } from "bun:test";
import { computeLatencyStats, groupByProvider, percentile } from "../src/usage/percentiles";

describe("computeLatencyStats", () => {
  it("reports extrema and percentiles for valid samples", () => {
    const stats = computeLatencyStats([10, 20, 30, 40]);
    expect(stats).toEqual({ count: 4, p50: 25, p95: 39, p99: 40, min: 10, max: 40, mean: 25 });
  });

  it("returns a zeroed block for an empty set", () => {
    expect(computeLatencyStats([])).toEqual({
      count: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0,
    });
  });

  it("drops non-finite and negative samples instead of poisoning the stats", () => {
    const stats = computeLatencyStats([10, Number.NaN, -5, 30, Number.POSITIVE_INFINITY]);
    expect(stats.count).toBe(2);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(30);
    expect(stats.mean).toBe(20);
    expect(Number.isFinite(stats.p95)).toBe(true);
  });

  it("returns a zeroed block when every sample is invalid", () => {
    expect(computeLatencyStats([Number.NaN, -1]).count).toBe(0);
  });

  it("computes extrema without spreading large sample arrays", () => {
    // 200k arguments overflows the engine's call stack when spread into Math.max.
    const samples = Array.from({ length: 200_000 }, (_, index) => index + 1);
    const stats = computeLatencyStats(samples);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(200_000);
  });
});

describe("groupByProvider", () => {
  it("buckets ttft and total latency per provider", () => {
    const stats = groupByProvider([
      { provider: "openai", durationMs: 100, firstOutputMs: 20 },
      { provider: "openai", durationMs: 300 },
      { provider: "anthropic", durationMs: 50, firstOutputMs: 10 },
    ]);
    expect(stats.get("openai")!.total.count).toBe(2);
    expect(stats.get("openai")!.ttft.count).toBe(1);
    expect(stats.get("anthropic")!.total.max).toBe(50);
  });

  it("skips invalid durations before bucketing", () => {
    const stats = groupByProvider([
      { provider: "openai", durationMs: Number.NaN, firstOutputMs: -3 },
      { provider: "openai", durationMs: 120, firstOutputMs: 40 },
    ]);
    expect(stats.get("openai")!.total.count).toBe(1);
    expect(stats.get("openai")!.ttft.count).toBe(1);
    expect(stats.get("openai")!.ttft.min).toBe(40);
  });
});

describe("percentile", () => {
  it("interpolates linearly and clamps p out of range", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], -10)).toBe(1);
    expect(percentile([1, 2, 3, 4], 150)).toBe(4);
    expect(percentile([], 50)).toBe(0);
  });
});
