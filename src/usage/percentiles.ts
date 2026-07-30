/**
 * Latency percentile computation for proxy request analytics.
 *
 * Pure functions — no I/O, no side effects. Used by the /api/latency-stats
 * endpoint and the GUI Logs page.
 */
export interface LatencyStats {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
}

export interface ProviderLatencySample {
  provider: string;
  /** Time-to-first-token (TTFT) in ms, if recorded. */
  firstOutputMs?: number;
  /** Total request duration in ms. */
  durationMs: number;
}

export interface ProviderLatencyStats {
  ttft: LatencyStats;
  total: LatencyStats;
}

/**
 * Linear-interpolation percentile (matches numpy.percentile default / R type 7).
 * Returns 0 for empty input.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0]!;
  const sorted = [...values].sort((a, b) => a - b);
  const clampedP = Math.max(0, Math.min(100, p));
  if (clampedP === 0) return sorted[0]!;
  if (clampedP === 100) return sorted[sorted.length - 1]!;
  const rank = (clampedP / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const frac = rank - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * frac;
}

/**
 * A latency sample only counts when it is finite and non-negative — the same
 * invariant `src/usage/summary.ts` enforces. One NaN would otherwise poison the
 * sum, the extrema, and every percentile.
 */
function isValidSample(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Compute the full stats block for a set of latency samples. */
export function computeLatencyStats(samples: number[]): LatencyStats {
  const valid = samples.every(isValidSample) ? samples : samples.filter(isValidSample);
  if (valid.length === 0) {
    return { count: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0 };
  }
  let sum = 0;
  let min = valid[0]!;
  let max = valid[0]!;
  // Iterative extrema: spreading a large sample array into Math.min/Math.max
  // can exceed the engine's argument limit and throw.
  for (const value of valid) {
    sum += value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return {
    count: valid.length,
    p50: Math.round(percentile(valid, 50)),
    p95: Math.round(percentile(valid, 95)),
    p99: Math.round(percentile(valid, 99)),
    min,
    max,
    mean: Math.round(sum / valid.length),
  };
}

/**
 * Group samples by provider and compute TTFT + total-latency stats per provider.
 * Samples without firstOutputMs only contribute to the total stats.
 */
export function groupByProvider(
  samples: ProviderLatencySample[],
): Map<string, ProviderLatencyStats> {
  const byProvider = new Map<string, { ttft: number[]; total: number[] }>();
  for (const s of samples) {
    let bucket = byProvider.get(s.provider);
    if (!bucket) {
      bucket = { ttft: [], total: [] };
      byProvider.set(s.provider, bucket);
    }
    if (isValidSample(s.durationMs)) bucket.total.push(s.durationMs);
    if (s.firstOutputMs !== undefined && isValidSample(s.firstOutputMs)) bucket.ttft.push(s.firstOutputMs);
  }
  const result = new Map<string, ProviderLatencyStats>();
  for (const [provider, bucket] of byProvider) {
    result.set(provider, {
      ttft: computeLatencyStats(bucket.ttft),
      total: computeLatencyStats(bucket.total),
    });
  }
  return result;
}
