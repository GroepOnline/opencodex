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
const CACHE_TTL_MS = 60_000;

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
  if (now - cacheBuiltAt > CACHE_TTL_MS) {
    sampleCache.clear();
    try {
      // Recent window only: scoring needs a coarse p50, not the full history. The window
      // filter itself runs per key below (samples carry no timestamps after aggregation).
      collectFromEntries(readRecentUsageEntries(RING_BUFFER_MAX_ENTRIES), sinceMs);
    } catch {
      /* unreadable log → no latency signal */
    }
    cacheBuiltAt = now;
  }
  const samples = sampleCache.get(cacheKey(provider, model));
  if (!samples || samples.length === 0) return null;
  return percentile(samples, 50);
}
