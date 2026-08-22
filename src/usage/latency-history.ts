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

type TimedSample = { durationMs: number; timestamp: number };

const sampleCache = new Map<string, TimedSample[]>();
let cacheBuiltAt = 0;
/** Window duration bucket the current sampleCache was built for. */
let cacheBuiltForWindowMs: number | null = null;
const CACHE_TTL_MS = 60_000;
const WINDOW_BUCKET_MS = 60_000;

function windowDurationBucket(sinceMs: number, now: number): number {
  const windowMs = Math.max(0, now - sinceMs);
  return Math.ceil(windowMs / WINDOW_BUCKET_MS) * WINDOW_BUCKET_MS;
}

function cacheKey(provider: string, model: string): string {
  return `${provider}\0${model}`;
}

function collectFromEntries(entries: PersistedUsageEntry[], coarseSinceMs: number): void {
  for (const entry of entries) {
    if (entry.timestamp < coarseSinceMs) continue;
    const duration = entry.durationMs;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) continue;
    const key = cacheKey(entry.provider, entry.model);
    let samples = sampleCache.get(key);
    if (!samples) {
      samples = [];
      sampleCache.set(key, samples);
    }
    samples.push({ durationMs: duration, timestamp: entry.timestamp });
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
  // Cache by requested window duration rather than the moving absolute sinceMs. Two calls using
  // the same latencyWindowMs therefore reuse one scan inside the TTL, while materially different
  // windows still rebuild independently.
  const bucketWindowMs = windowDurationBucket(sinceMs, now);
  if (now - cacheBuiltAt > CACHE_TTL_MS || cacheBuiltForWindowMs !== bucketWindowMs) {
    sampleCache.clear();
    try {
      // Read a coarse superset for this duration bucket, then filter against the exact requested
      // sinceMs below. This keeps routing semantics precise without rescanning on every request.
      collectFromEntries(readRecentUsageEntries(RING_BUFFER_MAX_ENTRIES), now - bucketWindowMs);
    } catch {
      /* unreadable log → no latency signal */
    }
    cacheBuiltAt = now;
    cacheBuiltForWindowMs = bucketWindowMs;
  }
  const samples = sampleCache.get(cacheKey(provider, model));
  if (!samples || samples.length === 0) return null;
  const exact = samples
    .filter((sample) => sample.timestamp >= sinceMs)
    .map((sample) => sample.durationMs);
  if (exact.length === 0) return null;
  return percentile(exact, 50);
}
