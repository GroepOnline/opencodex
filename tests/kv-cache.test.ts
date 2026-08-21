import { describe, expect, test, beforeEach, afterEach } from "bun:test";
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
    expect(cacheKeyFor("anthropic", "claude-opus-4-8", a!)).toBe(cacheKeyFor("anthropic", "claude-opus-4-8", b!));
  });

  test("non-deterministic fields (stream/user/metadata) are dropped", () => {
    const base = normalizeRequestBody(JSON.stringify({ model: "x", messages: [] }))!;
    const withUser = normalizeRequestBody(JSON.stringify({ model: "x", messages: [], user: "abc123" }))!;
    const withStream = normalizeRequestBody(JSON.stringify({ model: "x", messages: [], stream: true }))!;
    expect(base).toBe(withUser);
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
    expect(cacheKeyFor("anthropic", "m", body)).not.toBe(cacheKeyFor("openai", "m", body));
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
    cache.set("p", "m", "req", "{}", "application/json", 1000);
    expect(cache.get("p", "m", "req", 1000 + 2000)).toBeNull();
  });

  test("LRU eviction respects maxEntries", () => {
    for (let i = 0; i < 6; i++) {
      cache.set("p", "m", `req-${i}`, `{"i":${i}}`, "application/json");
    }
    expect(cache.size).toBeLessThanOrEqual(4);
  });

  test("sweep removes expired entries", () => {
    cache.set("p", "m", "req", "{}", "application/json", 1000);
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
