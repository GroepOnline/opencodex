/**
 * Per (provider, model) p50 duration from the usage log — the auto-router's latency input.
 *
 * Reads the in-memory ring buffer first (addRequestLog hydrates it at startup), then the
 * persisted usage file only when the buffer is empty. Never throws: a broken usage log must
 * degrade routing to "no latency signal" (null → neutral 0.5 score component), not break
 * requests. Samples are capped per key so one chatty provider cannot dominate memory.
 */

import { readRecentUsageEntries, type PersistedUsageEntry } from "./log";
import { percentile } from "./percentiles";

const MAX_SAMPLES_PER_KEY = 200;
/** Ring-buffer scan window; entries older than this are ignored even if still buffered. */
const RING_BUFFER_MAX_ENTRIES = 5_000;

const sampleCache = new Map<string, number[]>();
let cacheBuiltAt = 0;
/** Window the current sampleCache was built for. A different window forces a rebuild. */
let cacheBuiltForSinceMs: number | null = null;
const CACHE_TTL_MS = 60_000;
/**
 * Quantize windows to minute buckets. Callers derive `sinceMs` as `now - windowMs`, so a raw
 * comparison never matches twice and the TTL cache would be rebuilt on every request. All
 * windows in the same bucket share one (coarse, minute-granular) sample set — fine for a p50
 * scoring signal, and different windowMs still land in different buckets.
 */
const WINDOW_BUCKET_MS = 60_000;

function windowBucket(sinceMs: number): number {
  return Math.floor(sinceMs / WINDOW_BUCKET_MS) * WINDOW_BUCKET_MS;
}

function cacheKey(provider: string, model: string): string {
  return `${provider}\0${model}`;
}

function collectFromEntries(entries: PersistedUsageEntry[], sinceMs: number): void {
  for (const entry of entries) {
    if (entry.timestamp < sinceMs) continue;
    const duration = entry.durationMs;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) continue;
    const key = cacheKey(entry.provider, entry.model);
    let samples = sampleCache.get(key);
    if (!samples) {
      samples = [];
      sampleCache.set(key, samples);
    }
    samples.push(duration);
    // Keep the NEWEST half when over cap: cheap trim, biased toward recent behavior.
    if (samples.length > MAX_SAMPLES_PER_KEY * 2) {
      samples.splice(0, samples.length - MAX_SAMPLES_PER_KEY);
    }
  }
}

export function p50DurationForModel(
  provider: string,
  model: string,
  sinceMs: number,
  now = Date.now(),
): number | null {
  // Keep the requested window precise; aggregated samples are rebuilt for each distinct start.
  const bucketSinceMs = sinceMs;
  // Rebuild when the TTL lapses OR the caller asks for a different window bucket: the cache holds
  // aggregated samples with no per-entry timestamps, so a cache built for window A cannot
  // answer window B. Without the bucket check the first caller within the TTL would pin the
  // window for every later reader (e.g. the /api/router inspect endpoint vs. live routing).
  if (now - cacheBuiltAt > CACHE_TTL_MS || cacheBuiltForSinceMs !== bucketSinceMs) {
    sampleCache.clear();
    try {
      // Recent window only: scoring needs a coarse p50, not the full history. The window
      // filter itself runs per key below (samples carry no timestamps after aggregation).
      collectFromEntries(readRecentUsageEntries(RING_BUFFER_MAX_ENTRIES), bucketSinceMs);
    } catch {
      /* unreadable log → no latency signal */
    }
    cacheBuiltAt = now;
    cacheBuiltForSinceMs = bucketSinceMs;
  }
  const samples = sampleCache.get(cacheKey(provider, model));
  if (!samples || samples.length === 0) return null;
  return percentile(samples, 50);
}
