import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ResponseCache,
  normalizeRequestBody,
  requestOptsOutOfCache,
  cacheKeyFor,
  responseCacheFromConfig,
  DEFAULT_CACHE_TTL_MS,
} from "../src/cache/kv-cache";

describe("kv-cache key normalization", () => {
  test("stable key order collapses to the same hash", () => {
    const a = normalizeRequestBody(JSON.stringify({ a: 1, b: 2 }));
    const b = normalizeRequestBody(JSON.stringify({ b: 2, a: 1 }));
    expect(a).toBe(b);
    expect(cacheKeyFor("responses", "anthropic", "claude-opus-4-8", a!)).toBe(
      cacheKeyFor("responses", "anthropic", "claude-opus-4-8", b!),
    );
  });

  test("user and metadata remain in the cache key while stream is transport-only", () => {
    const base = normalizeRequestBody(JSON.stringify({ model: "x", messages: [] }))!;
    const withUser = normalizeRequestBody(JSON.stringify({ model: "x", messages: [], user: "abc123" }))!;
    const withMetadata = normalizeRequestBody(JSON.stringify({ model: "x", messages: [], metadata: { tenant: "a" } }))!;
    const withStream = normalizeRequestBody(JSON.stringify({ model: "x", messages: [], stream: true }))!;
    expect(base).not.toBe(withUser);
    expect(base).not.toBe(withMetadata);
    expect(base).toBe(withStream);
  });

  test("requestOptsOutOfCache detects stream + explicit no-store", () => {
    expect(requestOptsOutOfCache({ stream: true })).toBe(true);
    expect(requestOptsOutOfCache({ cache_control: "no-store" })).toBe(true);
    expect(requestOptsOutOfCache({ model: "x" })).toBe(false);
    expect(requestOptsOutOfCache(null)).toBe(false);
  });

  test("different providers/models yield different keys", () => {
    const body = normalizeRequestBody(JSON.stringify({ messages: [] }))!;
    expect(cacheKeyFor("responses", "anthropic", "m", body)).not.toBe(cacheKeyFor("responses", "openai", "m", body));
  });

  test("endpoint is part of the key: same body on two endpoints never collides", () => {
    const body = normalizeRequestBody(JSON.stringify({ model: "m", messages: [] }))!;
    expect(cacheKeyFor("responses", "p", "m", body))
      .not.toBe(cacheKeyFor("messages", "p", "m", body));
    expect(cacheKeyFor("messages", "p", "m", body))
      .not.toBe(cacheKeyFor("chat-completions", "p", "m", body));
  });
});

describe("ResponseCache lifecycle", () => {
  let cache: ResponseCache;

  beforeEach(() => {
    cache = new ResponseCache({ enabled: true, ttlMs: 1000, maxEntries: 4 });
    cache.startSweep(10_000);
  });
  afterEach(() => cache.stopSweep());

  test("disabled cache never stores or returns", () => {
    const off = new ResponseCache({ enabled: false });
    off.set("p", "m", "body", "{}", "application/json");
    expect(off.get("p", "m", "body")).toBeNull();
    expect(off.size).toBe(0);
  });

  test("store then hit returns the body + contentType", () => {
    cache.set("anthropic", "claude-opus-4-8", "req", '{"ok":true}', "application/json");
    const hit = cache.get("anthropic", "claude-opus-4-8", "req");
    expect(hit).not.toBeNull();
    expect(hit!.body).toBe('{"ok":true}');
    expect(hit!.contentType).toBe("application/json");
  });

  test("miss on unknown key", () => {
    expect(cache.get("anthropic", "m", "nope")).toBeNull();
  });

  test("expiry drops the entry", () => {
    cache.set("p", "m", "req", "{}", "application/json", undefined, 1000);
    expect(cache.get("p", "m", "req", 1000 + 2000)).toBeNull();
  });

  test("LRU eviction respects maxEntries", () => {
    for (let i = 0; i < 6; i++) {
      cache.set("p", "m", `req-${i}`, `{"i":${i}}`, "application/json");
    }
    expect(cache.size).toBeLessThanOrEqual(4);
  });

  test("sweep removes expired entries", () => {
    cache.set("p", "m", "req", "{}", "application/json", undefined, 1000);
    const removed = cache.sweep(1000 + 5000);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(cache.size).toBe(0);
  });

  test("responseCacheFromConfig is off unless enabled:true", () => {
    expect(responseCacheFromConfig({}).enabled).toBe(false);
    expect(responseCacheFromConfig({ responseCache: { enabled: true } }).enabled).toBe(true);
    expect(responseCacheFromConfig({ responseCache: { ttlMs: 5000 } }).enabled).toBe(false);
  });

  test("default ttl is applied when unset", () => {
    const c = responseCacheFromConfig({ responseCache: { enabled: true } });
    expect((c as unknown as { opts: { ttlMs: number } }).opts.ttlMs).toBe(DEFAULT_CACHE_TTL_MS);
  });
});

describe("ResponseCache observability + guards (Fase D quality round)", () => {
  test("stats count hits, misses, stores, evictions, expired, tooLarge", () => {
    const cache = new ResponseCache({ enabled: true, ttlMs: 1000, maxEntries: 2 });
    // Miss.
    expect(cache.get("p", "m", "a")).toBeNull();
    // Store three into capacity-2 → one eviction.
    for (const k of ["a", "b", "c"]) cache.set("p", "m", k, "{}", "application/json");
    // Hit + expired-miss.
    cache.get("p", "m", "c");
    cache.set("p", "m", "old", "{}", "application/json", undefined, Date.now() - 60_000);
    cache.get("p", "m", "old");
    // Too-large store rejected.
    cache.set("p", "m", "huge", "x".repeat(3 * 1024 * 1024), "application/json");

    const s = cache.cacheStats;
    expect(s.misses).toBeGreaterThanOrEqual(2);
    expect(s.hits).toBe(1);
    expect(s.stores).toBe(4); // huge was rejected before counting
    expect(s.evictions).toBeGreaterThanOrEqual(1);
    expect(s.expired).toBeGreaterThanOrEqual(1);
    expect(s.tooLarge).toBe(1);
  });

  test("bodies above maxBodyBytes are never stored", () => {
    const cache = new ResponseCache({ enabled: true, ttlMs: 1000, maxEntries: 8, maxBodyBytes: 64 });
    cache.set("p", "m", "big", "x".repeat(65), "application/json");
    expect(cache.size).toBe(0);
    expect(cache.cacheStats.tooLarge).toBe(1);
    cache.set("p", "m", "ok", "x".repeat(64), "application/json");
    expect(cache.size).toBe(1);
  });

  test("same normalized body under different endpoints does not cross-hit", () => {
    const cache = new ResponseCache({ enabled: true, ttlMs: 1000, maxEntries: 8 });
    cache.set("p", "m", "req", '{"via":"responses"}', "application/json", "responses");
    expect(cache.get("p", "m", "req", "messages")).toBeNull();
    expect(cache.get("p", "m", "req", "chat-completions")).toBeNull();
    expect(cache.get("p", "m", "req", "responses")!.body).toBe('{"via":"responses"}');
  });

  test("compactPersisted rewrites only live entries and clear() truncates the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-kvcache-"));
    const path = join(dir, "response-cache.jsonl");
    try {
      const cache = new ResponseCache(
        { enabled: true, ttlMs: 60_000, maxEntries: 8, persist: true },
        dir,
      );
      cache.set("p", "m", "live", '{"v":1}', "application/json");
      cache.set("p", "m", "dead", '{"v":2}', "application/json", undefined, Date.now() - 120_000);
      // Two lines appended; compact must drop the expired one.
      const raw = readFileSync(path, "utf8").trim().split("\n");
      expect(raw.length).toBe(2);
      cache.compactPersisted();
      const after = readFileSync(path, "utf8").trim().split("\n");
      expect(after.length).toBe(1);
      // The surviving line is the live entry (key is a hash; the body carries v:1).
      expect(JSON.parse(after[0]!).body).toBe('{"v":1}');

      cache.clear();
      expect(readFileSync(path, "utf8")).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("persisted entries survive a restart (warm start)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-kvcache-"));
    try {
      const first = new ResponseCache(
        { enabled: true, ttlMs: 60_000, maxEntries: 8, persist: true },
        dir,
      );
      first.set("p", "m", "req", '{"warm":true}', "application/json");

      const second = new ResponseCache(
        { enabled: true, ttlMs: 60_000, maxEntries: 8, persist: true },
        dir,
      );
      const hit = second.get("p", "m", "req");
      expect(hit).not.toBeNull();
      expect(hit!.body).toBe('{"warm":true}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
