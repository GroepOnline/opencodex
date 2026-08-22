/**
 * Proxy-level response KV cache.
 *
 * Caches identical non-streaming requests per (provider, model, endpoint) and replays the stored
 * response to cut cost and latency. The cache key is a SHA-256 of the normalized request body so
 * semantically-identical calls collide while non-deterministic fields (temperature jitter, a fresh
 * `user` id, an explicit no-cache flag) keep misses.
 *
 * Design constraints (see structure/11_standalone-vibe-proxy-goal.md Fase D):
 * - In-memory LRU + TTL. File persistence is OPT-IN and only ever writes completed entries, so a
 *   crash mid-write cannot replay a partial body.
 * - Streaming responses are NEVER cached — only a fully-consumed JSON body is safe to replay.
 * - No prompts, keys, or account ids reach the cache key or the log: the key is a hash; debug logs
 *   carry only a short key prefix + hit/miss + byte size.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../config";

export interface CacheEntry {
  /** SHA-256 hex of the normalized request (cache key). */
  key: string;
  provider: string;
  model: string;
  /** Stored response body (UTF-8 JSON/text). */
  body: string;
  /** Response content-type, replayed verbatim. */
  contentType: string;
  /** Epoch ms when the entry expires. */
  expiresAt: number;
  /** Epoch ms when stored (for LRU ordering + observability). */
  storedAt: number;
  /** Byte size of `body`, for capacity accounting. */
  size: number;
}

export interface ResponseCacheOptions {
  enabled: boolean;
  ttlMs: number;
  maxEntries: number;
  persist: boolean;
  maxBodyBytes?: number;
}

export const DEFAULT_CACHE_TTL_MS = 600_000;
export const DEFAULT_CACHE_MAX_ENTRIES = 1024;
export const MIN_CACHE_TTL_MS = 1_000;
export const MAX_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Bodies above this are never stored: one huge base64 image must not evict the whole LRU. */
export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Compact the append-only persist file every N sweep ticks (10 min at the default 60s). */
const COMPACT_EVERY_SWEEPS = 10;

export interface CacheStats {
  hits: number;
  misses: number;
  stores: number;
  /** Entries dropped by the LRU (capacity pressure), not by expiry. */
  evictions: number;
  expired: number;
  /** Store attempts rejected because the body exceeded maxBodyBytes. */
  tooLarge: number;
}

/** Transport-only fields already handled before cache-key generation. */
const TRANSPORT_ONLY_BODY_KEYS = new Set(["stream"]);

/** Recursively sort object keys so `{"a":1,"b":2}` and `{"b":2,"a":1}` hash identically. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(",")}}`;
}

/**
 * Normalize a request body for stable cache-key hashing:
 * - stable JSON key order (so `{"a":1,"b":2}` === `{"b":2,"a":1}`),
 * - drop only transport-mode fields handled as cache opt-outs; caller/user metadata remains keyed,
 * - keep model + provider separate (they are part of the key prefix, not the body hash).
 */
export function normalizeRequestBody(body: unknown): string | null {
  if (body === null || body === undefined) return null;
  try {
    const parsed = typeof body === "string" ? JSON.parse(body) : body;
    if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) {
      return typeof body === "string" ? body : stableStringify(body);
    }
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (TRANSPORT_ONLY_BODY_KEYS.has(k)) continue;
      cleaned[k] = v;
    }
    return stableStringify(cleaned);
  } catch {
    // Non-JSON body (raw text): hash as-is. Rare for these endpoints, but safe.
    return typeof body === "string" ? body : null;
  }
}

/** Whether a parsed request opts out of caching (explicit flags). */
export function requestOptsOutOfCache(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const obj = parsed as Record<string, unknown>;
  if (obj.stream === true) return true;
  if (obj["cache_control"] === "no-store") return true;
  // OpenAI/Anthropic explicit cache-control header is handled at the request layer; this catches
  // body-borne opt-outs only.
  return false;
}

export function cacheKeyFor(
  endpoint: string,
  provider: string,
  model: string,
  normalizedBody: string,
): string {
  return createHash("sha256").update(`${endpoint}\0${provider}\0${model}\0${normalizedBody}`).digest("hex");
}

export class ResponseCache {
  private readonly opts: ResponseCacheOptions;
  private readonly map = new Map<string, CacheEntry>();
  private readonly persistPath: string | null;
  private persistTimer: ReturnType<typeof setInterval> | null = null;
  private sweeps = 0;
  private stats: CacheStats = { hits: 0, misses: 0, stores: 0, evictions: 0, expired: 0, tooLarge: 0 };

  constructor(opts: Partial<ResponseCacheOptions> = {}, configDir?: string) {
    this.opts = {
      enabled: opts.enabled ?? false,
      ttlMs: Math.min(Math.max(opts.ttlMs ?? DEFAULT_CACHE_TTL_MS, MIN_CACHE_TTL_MS), MAX_CACHE_TTL_MS),
      maxEntries: Math.max(opts.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES, 1),
      persist: opts.persist ?? false,
      maxBodyBytes: Math.max(opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES, 1),
    };
    this.persistPath = this.opts.persist
      ? join(configDir ?? getConfigDir(), "response-cache.jsonl")
      : null;
    if (this.persistPath) this.loadPersisted();
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  get ttlMs(): number {
    return this.opts.ttlMs;
  }

  get maxEntries(): number {
    return this.opts.maxEntries;
  }

  get maxBodyBytes(): number {
    return this.opts.maxBodyBytes!;
  }

  get persistEnabled(): boolean {
    return this.opts.persist;
  }

  /** Cumulative hit/miss/store/eviction counters since process start (observability). */
  get cacheStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Look up a cached response. `endpoint` is part of the key: /v1/messages and
   * /v1/chat/completions carry different wire shapes for the same body and must never
   * replay each other's response. Returns the replayable body + contentType, or null.
   */
  get(
    provider: string,
    model: string,
    normalizedBody: string,
    endpoint = "responses",
    now = Date.now(),
  ): { body: string; contentType: string } | null {
    if (!this.opts.enabled) return null;
    const key = cacheKeyFor(endpoint, provider, model, normalizedBody);
    const entry = this.map.get(key);
    if (!entry) {
      this.stats.misses += 1;
      return null;
    }
    if (entry.expiresAt <= now) {
      this.map.delete(key);
      this.stats.expired += 1;
      this.stats.misses += 1;
      return null;
    }
    // LRU touch: re-insert to move to the most-recent end.
    this.map.delete(key);
    this.map.set(key, entry);
    this.stats.hits += 1;
    return { body: entry.body, contentType: entry.contentType };
  }

  /** Store a completed response. No-op when disabled or over capacity after eviction. */
  set(
    provider: string,
    model: string,
    normalizedBody: string,
    body: string,
    contentType: string,
    endpoint = "responses",
    now = Date.now(),
  ): void {
    if (!this.opts.enabled) return;
    // Measure real UTF-8 bytes, not UTF-16 code units: `body.length` under-counts multi-byte
    // JSON, so a "2MB" cap would silently admit larger payloads than intended.
    const byteSize = Buffer.byteLength(body, "utf8");
    if (byteSize > this.opts.maxBodyBytes!) {
      this.stats.tooLarge += 1;
      return;
    }
    const key = cacheKeyFor(endpoint, provider, model, normalizedBody);
    const entry: CacheEntry = {
      key,
      provider,
      model,
      body,
      contentType,
      expiresAt: now + this.opts.ttlMs,
      storedAt: now,
      size: byteSize,
    };
    this.map.delete(key);
    this.map.set(key, entry);
    this.evictIfNeeded();
    this.stats.stores += 1;
    if (this.persistPath) this.persistEntry(entry);
  }

  /** Short key prefix for debug logs (never the full hash, never the body). */
  static keyPrefix(endpoint: string, provider: string, model: string, normalizedBody: string): string {
    return cacheKeyFor(endpoint, provider, model, normalizedBody).slice(0, 12);
  }

  private evictIfNeeded(): void {
    while (this.map.size > this.opts.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
      this.stats.evictions += 1;
    }
  }

  private loadPersisted(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const text = readFileSync(this.persistPath, "utf8");
      const now = Date.now();
      let loaded = 0;
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed) as CacheEntry;
          if (entry.expiresAt > now && typeof entry.body === "string") {
            this.map.set(entry.key, entry);
            loaded++;
          }
        } catch {
          // Skip a corrupt line; never fail startup on a partial cache file.
        }
      }
      this.evictIfNeeded();
      if (loaded > 0) {
        console.warn(`[kv-cache] warmed ${loaded} response-cache entries from disk`);
      }
    } catch {
      // Missing/unreadable cache file is non-fatal.
    }
  }

  private persistEntry(entry: CacheEntry): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileSync(this.persistPath, `${JSON.stringify(entry)}\n`, { flag: "a" });
      try { chmodSync(this.persistPath, 0o600); } catch { /* best effort */ }
    } catch {
      // A failed append must never break the request path.
    }
  }

  /** Drop expired entries (called periodically by the server). */
  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (entry.expiresAt <= now) {
        this.map.delete(key);
        removed++;
        this.stats.expired += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.map.size;
  }

  /** Start a periodic sweep + persist-compaction. Caller owns the timer lifecycle (server shutdown). */
  startSweep(intervalMs = 60_000): void {
    if (this.persistTimer) return;
    this.persistTimer = setInterval(() => {
      // Count this tick first so the compaction gate lands on the intended cadence: with the
      // increment in `finally`, `sweeps` was still 0 on the first tick and compaction ran at
      // ~60s instead of the documented 10 minutes.
      this.sweeps += 1;
      try {
        this.sweep();
        // Compact the append-only file on a slow cadence: expired/evicted lines would
        // otherwise accumulate forever and re-warm dead entries at every startup.
        if (this.sweeps % COMPACT_EVERY_SWEEPS === 0) this.compactPersisted();
      } catch {
        /* best-effort: a failed sweep must never take the proxy down */
      }
    }, intervalMs);
    // Don't keep the event loop alive solely for the cache.
    if (typeof this.persistTimer.unref === "function") this.persistTimer.unref();
  }

  stopSweep(): void {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
  }

  /**
   * Rewrite the persist file to only the live entries. Append-only writes keep the request
   * path fast, but without this the file grows monotonically: every rewrite of an entry
   * (re-store after LRU eviction + re-miss) adds a line, and startup warms ALL of them.
   */
  compactPersisted(now = Date.now()): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const lines = [...this.map.values()]
        .filter(entry => entry.expiresAt > now)
        .map(entry => `${JSON.stringify(entry)}\n`);
      const tmp = `${this.persistPath}.tmp`;
      writeFileSync(tmp, lines.join(""), { mode: 0o600 });
      renameSync(tmp, this.persistPath);
      try { chmodSync(this.persistPath, 0o600); } catch { /* best effort */ }
    } catch {
      // A failed compaction is non-fatal; the next sweep retries.
    }
  }

  /** Clear the whole cache (operator action) — also drops the persisted copy. */
  clear(): void {
    this.map.clear();
    if (this.persistPath && existsSync(this.persistPath)) {
      try {
        writeFileSync(this.persistPath, "", { mode: 0o600 });
      } catch { /* best effort */ }
    }
  }
}

/** Build a ResponseCache from config (off unless explicitly enabled). */
export function responseCacheFromConfig(
  config: { responseCache?: { enabled?: boolean; ttlMs?: number; maxEntries?: number; persist?: boolean } },
  configDir?: string,
): ResponseCache {
  return new ResponseCache(
    {
      enabled: config.responseCache?.enabled === true,
      ttlMs: config.responseCache?.ttlMs,
      maxEntries: config.responseCache?.maxEntries,
      persist: config.responseCache?.persist === true,
    },
    configDir,
  );
}
