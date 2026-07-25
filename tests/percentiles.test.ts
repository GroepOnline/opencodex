import { describe, expect, it } from "bun:test";
import { percentile, computeLatencyStats, groupByProvider } from "../src/usage/percentiles";

describe("percentile", () => {
  it("returns 0 for empty input", () => {
    expect(percentile([], 50)).toBe(0);
  });

  it("returns the single value for one-element input", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });

  it("returns min at p0 and max at p100", () => {
    expect(percentile([10, 20, 30, 40, 50], 0)).toBe(10);
    expect(percentile([10, 20, 30, 40, 50], 100)).toBe(50);
  });

  it("matches known linear-interpolation percentiles", () => {
    // 1..10 — p50 = 5.5, p95 = 9.55, p99 = 9.91
    const vals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(vals, 50)).toBeCloseTo(5.5, 5);
    expect(percentile(vals, 95)).toBeCloseTo(9.55, 5);
    expect(percentile(vals, 99)).toBeCloseTo(9.91, 5);
  });

  it("handles unsorted input (sorts internally)", () => {
    expect(percentile([50, 10, 30, 40, 20], 50)).toBe(30);
  });
});

describe("computeLatencyStats", () => {
  it("returns zeroed stats for empty input", () => {
    const s = computeLatencyStats([]);
    expect(s.count).toBe(0);
    expect(s.p50).toBe(0);
  });

  it("computes correct stats", () => {
    const s = computeLatencyStats([100, 200, 300, 400, 500]);
    expect(s.count).toBe(5);
    expect(s.min).toBe(100);
    expect(s.max).toBe(500);
    expect(s.mean).toBe(300);
    expect(s.p50).toBe(300);
  });
});

describe("groupByProvider", () => {
  it("groups samples by provider and separates ttft from total", () => {
    const samples = [
      { provider: "openai", firstOutputMs: 100, durationMs: 1000 },
      { provider: "openai", firstOutputMs: 200, durationMs: 1200 },
      { provider: "anthropic", durationMs: 800 }, // no ttft
    ];
    const result = groupByProvider(samples);
    expect(result.size).toBe(2);
    expect(result.get("openai")!.total.count).toBe(2);
    expect(result.get("openai")!.ttft.count).toBe(2);
    expect(result.get("anthropic")!.total.count).toBe(1);
    expect(result.get("anthropic")!.ttft.count).toBe(0); // no ttft samples
  });
});
