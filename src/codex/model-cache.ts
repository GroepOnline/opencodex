/**
 * In-memory, per-provider TTL cache for live `/models` results.
 *
 * Ported in spirit from jawcode's packages/ai/src/model-manager.ts (the "always load the latest
 * model list" resolver): live fetch when the cache is stale, serve the cache while it is fresh,
 * and fall back to the last-known-good list when a live fetch fails. opencodex's proxy is a single
 * long-running process and the on-disk Codex catalog already persists the last sync across
 * restarts, so an in-memory cache is sufficient here (no SQLite layer needed).
 */
import type { CatalogModel } from "./catalog";

/** Default freshness window. Matches Codex's own 5-min models cache so the two stay in step. */
export const DEFAULT_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  models: CatalogModel[];
  fetchedAt: number;
}

interface FailureBackoff {
  /** Consecutive live-discovery failures since the last success. */
  attempts: number;
  /** Earliest time a live re-probe may run. */
  retryAfterMs: number;
}

export type ProviderModelDiscoveryFailureReason =
  | "http"
  | "blocked"
  | "invalid_response"
  | "network"
  | "provider";

export type ProviderModelDiscoveryStatus =
  | { status: "ok" }
  | { status: "failed"; reason: "http"; httpStatus: number }
  | {
      status: "failed";
      reason: Exclude<ProviderModelDiscoveryFailureReason, "http">;
      httpStatus?: never;
    };

export type ProviderModelDiscoveryFailure = ProviderModelDiscoveryStatus extends infer Status
  ? Status extends { status: "failed" }
    ? Omit<Status, "status">
    : never
  : never;

const cache = new Map<string, CacheEntry>();

/** Base cooldown after the first failed live `/models` fetch. Subsequent failures double until
 * {@link MODELS_FETCH_FAILURE_MAX_COOLDOWN_MS} (issue #54: UI stalls behind corporate proxies). */
export const MODELS_FETCH_FAILURE_COOLDOWN_MS = 30_000;

/** Ceiling for discovery exponential backoff. */
export const MODELS_FETCH_FAILURE_MAX_COOLDOWN_MS = 15 * 60 * 1000;

const failureBackoff = new Map<string, FailureBackoff>();
const discoveryStatus = new Map<string, ProviderModelDiscoveryStatus>();
/**
 * How many models the last successful discovery actually returned, before any configured-alias
 * augmentation or custom-model merge. Consumers cannot recover this by subtracting known custom
 * ids: a custom id that later also appears upstream would make a real live catalog look
 * custom-only, and the provider's configured fallback would wrongly stay authoritative.
 */
const liveModelCounts = new Map<string, number>();

function clearFailureBackoff(provider: string): void {
  failureBackoff.delete(provider);
}

/**
 * Record a live discovery probe failure and schedule the next probe with exponential backoff.
 * Resets only on the next successful discovery ({@link markProviderDiscoveryOk}).
 */
export function markModelsFetchFailure(provider: string, now = Date.now()): void {
  const prev = failureBackoff.get(provider);
  const attempts = (prev?.attempts ?? 0) + 1;
  const delayMs = Math.min(
    MODELS_FETCH_FAILURE_MAX_COOLDOWN_MS,
    MODELS_FETCH_FAILURE_COOLDOWN_MS * 2 ** (attempts - 1),
  );
  failureBackoff.set(provider, { attempts, retryAfterMs: now + delayMs });
}

/** Consecutive discovery failures since the last success (0 when healthy / never failed). */
export function getDiscoveryFailStreak(provider: string): number {
  return failureBackoff.get(provider)?.attempts ?? 0;
}

/** `liveModelCount` is required so a caller that forgets to pass it fails typecheck instead of
 * silently recording zero and misclassifying the provider as having no live catalog. */
export function markProviderDiscoveryOk(provider: string, liveModelCount: number): void {
  clearFailureBackoff(provider);
  discoveryStatus.set(provider, { status: "ok" });
  liveModelCounts.set(provider, Math.max(0, Math.floor(liveModelCount)));
}

export function markProviderDiscoveryFailed(
  provider: string,
  failure: ProviderModelDiscoveryFailure,
): void {
  discoveryStatus.set(provider, { status: "failed", ...failure });
}

/**
 * Decide whether a discovery FAILURE should be logged, to avoid flooding the log with an identical
 * warning on every poll (#395: an anthropic-adapter baseUrl without `/v1/models`, e.g. Azure AI
 * Foundry, returns HTTP 404 forever; the 30s cooldown re-probes and previously re-logged each time).
 *
 * Returns true only when the failure SIGNATURE changed since the last observed status — i.e. the
 * previous state was ok/undefined, or a different reason/httpStatus. Repeated identical failures
 * stay observable through `getProviderDiscoveryStatus()` / the providers API without log spam.
 * Call this BEFORE `markProviderDiscoveryFailed` so it can see the prior state.
 */
export function shouldLogDiscoveryFailure(
  provider: string,
  failure: ProviderModelDiscoveryFailure,
): boolean {
  const prev = discoveryStatus.get(provider);
  if (!prev || prev.status !== "failed") return true;
  if (prev.reason !== failure.reason) return true;
  if (prev.reason === "http" && failure.reason === "http") {
    return prev.httpStatus !== failure.httpStatus;
  }
  return false;
}

export function clearProviderDiscoveryStatus(provider: string): void {
  clearFailureBackoff(provider);
  discoveryStatus.delete(provider);
  liveModelCounts.delete(provider);
}

export function getProviderDiscoveryStatus(provider: string): ProviderModelDiscoveryStatus | undefined {
  return discoveryStatus.get(provider);
}

/** Undefined when discovery has never succeeded for this provider. A failed refresh keeps the
 * last successful count so a stale catalog is still recognised as live-origin. */
export function getProviderLiveModelCount(provider: string): number | undefined {
  return liveModelCounts.get(provider);
}

/**
 * Whether a live `/models` probe should be skipped. `cooldownMs` is retained for call-site
 * compatibility; the effective wait is the exponential schedule written by
 * {@link markModelsFetchFailure}.
 */
export function isModelsFetchCoolingDown(
  provider: string,
  _cooldownMs = MODELS_FETCH_FAILURE_COOLDOWN_MS,
  now = Date.now(),
): boolean {
  const entry = failureBackoff.get(provider);
  return entry !== undefined && now < entry.retryAfterMs;
}

/** Fresh cached models for a provider, or null when absent/stale (caller should re-fetch). */
export function getFreshCached(provider: string, ttlMs: number, now = Date.now()): CatalogModel[] | null {
  const entry = cache.get(provider);
  if (!entry) return null;
  return now - entry.fetchedAt < ttlMs ? entry.models : null;
}

/** Last-known-good models regardless of age — the fallback when a live fetch fails. */
export function getStaleCached(provider: string): CatalogModel[] | null {
  return cache.get(provider)?.models ?? null;
}

export function setCached(provider: string, models: CatalogModel[], now = Date.now()): void {
  cache.set(provider, { models, fetchedAt: now });
}

/** Drop one provider's cache (or all) so the next resolve forces a live re-fetch. */
export function clearModelCache(provider?: string): void {
  if (provider) {
    cache.delete(provider);
    clearFailureBackoff(provider);
    discoveryStatus.delete(provider);
    liveModelCounts.delete(provider);
  } else {
    cache.clear();
    failureBackoff.clear();
    discoveryStatus.clear();
    liveModelCounts.clear();
  }
}
