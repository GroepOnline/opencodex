/**
 * Multi-key 429 failover for non-OpenAI providers.
 *
 * When a provider's upstream returns 429, this module picks the next available key
 * from `apiKeyPool`, puts the exhausted key into cooldown (respecting Retry-After),
 * and returns a fresh provider config with the swapped key. If all keys are in
 * cooldown, returns null so the caller surfaces the 429 to the client.
 *
 * Modelled after src/codex/routing.ts cooldown logic but scoped to plain API-key pools.
 */
import { resolveEnvValue, saveConfigPreservingClaudeCode } from "../config";
import type { AdapterRateLimitInfo } from "../adapters/base";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { hasKeyPoolFailover } from "./api-keys";
import { isHardCapMessage, parseResetsInMs } from "./cap-cooldown";
import { resolveProviderTransport, type OcxProviderTransport } from "./xai-transport";
import { noteProviderAccountUsed } from "./account-runtime-state";

export { hasKeyPoolFailover } from "./api-keys";

// ---- cooldown state (in-memory, same as codex/routing.ts) ----

interface KeyCooldown {
  cooldownUntil: number;
}

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 10 * 60_000; // ordinary 429 Retry-After
const MAX_HARD_CAP_KEY_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
const HARD_CAP_DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Map<`${providerName}\0${keyId}`, KeyCooldown> */
const keyCooldowns = new Map<string, KeyCooldown>();

function cooldownKey(providerName: string, keyId: string): string {
  return `${providerName}\0${keyId}`;
}

function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(Math.max(Math.ceil(seconds * 1000), 1), MAX_COOLDOWN_MS);
    }
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return undefined;
  const delay = timestamp - now;
  return delay > 0 ? Math.min(delay, MAX_COOLDOWN_MS) : undefined;
}

function cooldownMsForFailure(
  status: number,
  retryAfterHeader: string | null | undefined,
  message: string | undefined,
  now: number,
  rateLimit?: AdapterRateLimitInfo | null,
): number {
  // Provider-parsed signal wins when present (Fase C): a per-account spend cap with NO
  // retry-after must cool the key for a long window (it will not recover by rotating), and
  // a provider-supplied retry-after (anthropic-ratelimit reset / openai x-ratelimit) should
  // be honored over the generic default.
  if (rateLimit) {
    if (rateLimit.hardCap) {
      return HARD_CAP_DEFAULT_COOLDOWN_MS;
    }
    if (rateLimit.retryAfterSec != null) {
      return Math.min(Math.max(rateLimit.retryAfterSec * 1000, 1), MAX_COOLDOWN_MS);
    }
  }
  if (isHardCapMessage(status, message)) {
    const until = parseResetsInMs(message || "", now);
    if (until !== undefined) {
      return Math.min(Math.max(until - now, 1), MAX_HARD_CAP_KEY_COOLDOWN_MS);
    }
    return HARD_CAP_DEFAULT_COOLDOWN_MS;
  }
  return parseRetryAfterMs(retryAfterHeader, now) ?? DEFAULT_COOLDOWN_MS;
}

function isKeyInCooldown(providerName: string, keyId: string, now = Date.now()): boolean {
  const entry = keyCooldowns.get(cooldownKey(providerName, keyId));
  if (!entry) return false;
  if (entry.cooldownUntil <= now) {
    keyCooldowns.delete(cooldownKey(providerName, keyId));
    return false;
  }
  return true;
}

// ---- public API ----

function resolvedStoredApiKey(stored: string | undefined): string | undefined {
  return resolveEnvValue(stored) ?? stored;
}

function poolEntryForKey(
  pool: NonNullable<OcxProviderConfig["apiKeyPool"]>,
  liveKey: string | undefined,
): NonNullable<OcxProviderConfig["apiKeyPool"]>[number] | undefined {
  if (!liveKey) return undefined;
  const direct = pool.find(entry => entry.key === liveKey);
  if (direct) return direct;
  return pool.find(entry => {
    const resolved = resolveEnvValue(entry.key);
    return Boolean(resolved) && resolved === liveKey;
  });
}

function pickUncooledKey(
  providerName: string,
  pool: NonNullable<OcxProviderConfig["apiKeyPool"]>,
  fromIndex: number,
  now: number,
): NonNullable<OcxProviderConfig["apiKeyPool"]>[number] | null {
  if (fromIndex < 0) {
    for (const candidate of pool) {
      if (!isKeyInCooldown(providerName, candidate.id, now)) return candidate;
    }
    return null;
  }
  // Skip `fromIndex` itself: callers asked to move away from that entry.
  for (let i = 1; i < pool.length; i++) {
    const candidate = pool[(fromIndex + i) % pool.length]!;
    if (!isKeyInCooldown(providerName, candidate.id, now)) return candidate;
  }
  return null;
}

function persistHardCapKeyCooldown(
  config: OcxConfig,
  providerName: string,
  keyId: string,
  until: number,
): void {
  const bag = (config.keyPoolCooldowns ??= {});
  const keys = (bag[providerName] ??= {});
  keys[keyId] = { until };
}

function applyFailedKeyCooldown(
  config: OcxConfig,
  providerName: string,
  pool: NonNullable<OcxProviderConfig["apiKeyPool"]>,
  failedKey: string | undefined,
  retryAfterHeader: string | null | undefined,
  message: string | undefined,
  status: number,
  now: number,
  rateLimit?: AdapterRateLimitInfo | null,
): { currentEntry: NonNullable<OcxProviderConfig["apiKeyPool"]>[number] | undefined; persistedHardCap: boolean } {
  const currentEntry = poolEntryForKey(pool, failedKey);
  if (!currentEntry) return { currentEntry: undefined, persistedHardCap: false };
  const cooldownMs = cooldownMsForFailure(status, retryAfterHeader, message, now, rateLimit);
  const until = now + cooldownMs;
  keyCooldowns.set(cooldownKey(providerName, currentEntry.id), {
    cooldownUntil: until,
  });
  const persistedHardCap = cooldownMs > MAX_COOLDOWN_MS;
  // Persist EVERY cooldown (not just hard-cap ones) so a proxy restart mid-rate-limit
  // respects the in-flight cooldowns instead of re-hitting an already-exhausted key.
  // The config save is already triggered by the caller's `needsSave` path.
  persistHardCapKeyCooldown(config, providerName, currentEntry.id, until);
  return { currentEntry, persistedHardCap };
}

function poolAllKeysCooling(
  providerName: string,
  pool: NonNullable<OcxProviderConfig["apiKeyPool"]>,
  now: number,
): boolean {
  return pool.every(entry => isKeyInCooldown(providerName, entry.id, now));
}

function earliestCooldownRetryAfterSeconds(
  providerName: string,
  pool: NonNullable<OcxProviderConfig["apiKeyPool"]>,
  now: number,
): number {
  let soonest = Number.POSITIVE_INFINITY;
  for (const entry of pool) {
    const until = getKeyCooldownUntil(providerName, entry.id, now);
    if (until !== null && until < soonest) soonest = until;
  }
  if (!Number.isFinite(soonest)) return 1;
  return Math.max(1, Math.ceil((soonest - now) / 1000));
}

/**
 * Record a 429 for the current key and attempt to switch to the next available one.
 *
 * @returns A new OcxProviderConfig with the swapped key (and mutated config on disk),
 *          or `null` when no alternative key is available (all in cooldown or pool < 2).
 *
 * The returned object is a snapshot of the PERSISTED config — it carries none of the
 * registry backfills `routedProviderConfig` merges in at request time. Request paths must
 * not assign it to an active route wholesale; use `rotateProviderTransportOn429`, which
 * takes only the swapped key and keeps the routed provider intact.
 */
export function rotateKeyOn429(
  config: OcxConfig,
  providerName: string,
  retryAfterHeader: string | null | undefined,
  now = Date.now(),
  attemptedKey?: string,
  message?: string,
  status = 429,
  persistConfig?: OcxConfig,
  rateLimit?: AdapterRateLimitInfo | null,
): OcxProviderConfig | null {
  const provider = config.providers[providerName];
  if (!provider) return null;
  if (provider.authMode === "oauth" || provider.authMode === "forward") return null;

  const pool = provider.apiKeyPool;
  if (!pool || pool.length < 2) return null;

  // Cool the key that ACTUALLY failed. Under concurrent 429s another request may already have
  // rotated provider.apiKey — cooling the live key would punish an innocent replacement and can
  // exhaust a 2-key pool from a single bad key. CAS semantics: callers pass the key they used.
  const failedKey = attemptedKey ?? provider.apiKey;
  const { currentEntry, persistedHardCap } = applyFailedKeyCooldown(
    config,
    providerName,
    pool,
    failedKey,
    retryAfterHeader,
    message,
    status,
    now,
    rateLimit,
  );
  // Every cooldown is now persisted, so always save on a failure (the active key rotated,
  // and any cooldown entry was written to config.keyPoolCooldowns).
  const needsSave = true;

  // Lost the race: someone already rotated away from the failed key. If the live key is healthy,
  // retry with it as-is instead of rotating a second time.
  if (attemptedKey !== undefined && provider.apiKey !== attemptedKey) {
    const liveEntry = poolEntryForKey(pool, provider.apiKey);
    if (liveEntry && !isKeyInCooldown(providerName, liveEntry.id, now)) {
      if (needsSave) saveConfigRoot(config, persistConfig);
      return { ...provider };
    }
  }

  const currentIndex = currentEntry ? pool.indexOf(currentEntry) : -1;
  const candidate = pickUncooledKey(providerName, pool, currentIndex, now);
  if (candidate) {
    provider.apiKey = candidate.key;
    saveConfigRoot(config, persistConfig);
    console.warn(
      // Log ids only — labels are user-supplied free text and could carry secret material.
      `[key-failover] ${providerName}: 429 on key ${currentEntry?.id ?? "?"}; rotating to key ${candidate.id}`,
    );
    noteProviderAccountUsed("key-pool", providerName, candidate.id, now);
    return { ...provider };
  }

  if (needsSave) saveConfigRoot(config, persistConfig);
  console.warn(`[key-failover] ${providerName}: all ${pool.length} keys in cooldown; returning 429 to client`);
  return null;
}

/**
 * Cool the attempted key without hopping. Used for 402 (account-exhausted) on a pool:
 * Availability must not rotate, but the spent key should stop being first-picked.
 * Returns true when every pool entry is now cooling.
 */
export function coolAttemptedKey(
  config: OcxConfig,
  providerName: string,
  options: RotateProviderTransportOptions & { status?: number } = {},
): boolean {
  const provider = config.providers[providerName];
  if (!provider || !hasKeyPoolFailover(provider)) return false;
  const pool = provider.apiKeyPool!;
  const now = options.now ?? Date.now();
  const { persistedHardCap } = applyFailedKeyCooldown(
    config,
    providerName,
    pool,
    options.attemptedKey ?? provider.apiKey,
    options.retryAfter,
    options.message,
    options.status ?? 402,
    now,
    options.rateLimit,
  );
  // Every cooldown is now persisted; save so a restart respects the cooled key.
  saveConfigRoot(config, options.persistConfig);
  return poolAllKeysCooling(providerName, pool, now);
}

interface RotateProviderTransportOptions {
  retryAfter?: string | null;
  now?: number;
  attemptedKey?: string;
  promptCacheKey?: string;
  message?: string;
  status?: number;
  /** Provider-parsed rate-limit signal (from the adapter). Overrides generic cooldown math. */
  rateLimit?: AdapterRateLimitInfo | null;
  /** Live server config for disk writes when the working config is a routing clone. */
  persistConfig?: OcxConfig;
}

function saveConfigRoot(working: OcxConfig, persistRoot?: OcxConfig): void {
  saveConfigPreservingClaudeCode(persistRoot ?? working);
}

/**
 * Rotate a failed key and re-apply provider-specific transport metadata to the replacement.
 *
 * `routedProvider` is the request's active provider (the `routedProviderConfig` output the
 * route was built with). The result inherits it and swaps ONLY the API key: the persisted
 * config that `rotateKeyOn429` snapshots predates registry backfill, so building the retry
 * provider from that snapshot would silently drop every field the registry merged in at
 * routing time (scalar flags like `promptCacheKey`/`parallelToolCalls`, merged model
 * metadata such as `noTemperatureModels`, a pinned baseUrl). Mirrors the OAuth-401 replay
 * path in src/server/responses/core.ts, which spreads `route.provider` for the same reason.
 */
export function rotateProviderTransportOn429(
  config: OcxConfig,
  providerName: string,
  routedProvider: OcxProviderTransport,
  options: RotateProviderTransportOptions = {},
): OcxProviderTransport | null {
  const rotated = rotateKeyOn429(
    config,
    providerName,
    options.retryAfter,
    options.now,
    options.attemptedKey,
    options.message,
    options.status,
    options.persistConfig,
    options.rateLimit,
  );
  return rotated
    ? resolveProviderTransport(
        providerName,
        { ...routedProvider, apiKey: resolvedStoredApiKey(rotated.apiKey) },
        options.promptCacheKey,
      )
    : null;
}

export type UncooledApiKeyPick =
  | { kind: "noop" }
  | { kind: "swapped"; provider: OcxProviderConfig }
  | { kind: "all-cooled"; retryAfterSeconds: number };

/**
 * First pick: if the active key is cooling, persist the next uncooled key.
 * Distinguishes "live key is fine" from "every key is cooling".
 */
export function pickUncooledApiKey(
  config: OcxConfig,
  providerName: string,
  now = Date.now(),
  attemptedKey?: string,
): UncooledApiKeyPick {
  const provider = config.providers[providerName];
  if (!provider || !hasKeyPoolFailover(provider)) return { kind: "noop" };
  const pool = provider.apiKeyPool!;
  const liveKey = attemptedKey ?? provider.apiKey;
  const current = poolEntryForKey(pool, liveKey) ?? poolEntryForKey(pool, provider.apiKey);
  if (current && !isKeyInCooldown(providerName, current.id, now)) return { kind: "noop" };
  const fromIndex = current ? pool.indexOf(current) : -1;
  const candidate = pickUncooledKey(providerName, pool, fromIndex, now);
  if (!candidate) {
    return {
      kind: "all-cooled",
      retryAfterSeconds: earliestCooldownRetryAfterSeconds(providerName, pool, now),
    };
  }
  if (candidate.key === provider.apiKey) return { kind: "noop" };
  provider.apiKey = candidate.key;
  saveConfigPreservingClaudeCode(config);
  noteProviderAccountUsed("key-pool", providerName, candidate.id, now);
  return { kind: "swapped", provider: { ...provider } };
}

/** First pick: if the active key is cooling, persist the next uncooled key. */
export function activateUncooledApiKey(
  config: OcxConfig,
  providerName: string,
  now = Date.now(),
  attemptedKey?: string,
): OcxProviderConfig | null {
  const pick = pickUncooledApiKey(config, providerName, now, attemptedKey);
  return pick.kind === "swapped" ? pick.provider : null;
}

/** Clear cooldown state for a provider (e.g. after manual key management). */
export function clearKeyCooldowns(providerName?: string, config?: OcxConfig): boolean {
  let persistedChanged = false;
  if (!providerName) {
    keyCooldowns.clear();
    if (config?.keyPoolCooldowns) {
      delete config.keyPoolCooldowns;
      persistedChanged = true;
    }
    return persistedChanged;
  }
  const prefix = `${providerName}\0`;
  for (const key of keyCooldowns.keys()) {
    if (key.startsWith(prefix)) keyCooldowns.delete(key);
  }
  if (config?.keyPoolCooldowns && Object.hasOwn(config.keyPoolCooldowns, providerName)) {
    delete config.keyPoolCooldowns[providerName];
    if (Object.keys(config.keyPoolCooldowns).length === 0) delete config.keyPoolCooldowns;
    persistedChanged = true;
  }
  return persistedChanged;
}

/** Load persisted hard-cap key windows into the in-memory map (startup). */
export function hydrateKeyPoolCooldowns(config: OcxConfig, now = Date.now()): void {
  const bag = config.keyPoolCooldowns;
  if (!bag) return;
  for (const [providerName, keys] of Object.entries(bag)) {
    if (!keys || typeof keys !== "object") continue;
    for (const [keyId, entry] of Object.entries(keys)) {
      if (!entry || typeof entry.until !== "number" || !Number.isFinite(entry.until)) continue;
      if (entry.until <= now) continue;
      keyCooldowns.set(cooldownKey(providerName, keyId), { cooldownUntil: entry.until });
    }
  }
}

/** Drop expired persisted key windows. Returns true when config was mutated. */
export function expireKeyPoolCooldowns(config: OcxConfig, now = Date.now()): boolean {
  const bag = config.keyPoolCooldowns;
  if (!bag) return false;
  let changed = false;
  for (const [providerName, keys] of Object.entries(bag)) {
    if (!keys || typeof keys !== "object") {
      delete bag[providerName];
      changed = true;
      continue;
    }
    for (const [keyId, entry] of Object.entries(keys)) {
      if (!entry || typeof entry.until !== "number" || entry.until <= now) {
        delete keys[keyId];
        keyCooldowns.delete(cooldownKey(providerName, keyId));
        changed = true;
      }
    }
    if (Object.keys(keys).length === 0) {
      delete bag[providerName];
      changed = true;
    }
  }
  if (changed && Object.keys(bag).length === 0) {
    delete config.keyPoolCooldowns;
  }
  return changed;
}

/** Visible-for-testing: get the cooldown-until timestamp for a key. */
export function getKeyCooldownUntil(providerName: string, keyId: string, now = Date.now()): number | null {
  const entry = keyCooldowns.get(cooldownKey(providerName, keyId));
  if (!entry) return null;
  return entry.cooldownUntil > now ? entry.cooldownUntil : null;
}
