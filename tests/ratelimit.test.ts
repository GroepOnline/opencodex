import { describe, expect, test } from "bun:test";
import {
  PrincipalFingerprinter,
  TokenBucketLimiter,
  WebSocketConcurrencyLimiter,
  validateRateLimitPolicy,
} from "../src/ratelimit";

const SECRET_A = new Uint8Array(32).fill(0x11);
const SECRET_B = new Uint8Array(32).fill(0x22);

function principals() {
  const fingerprinter = new PrincipalFingerprinter(SECRET_A);
  return {
    a: fingerprinter.admissionKey("sk-secret-a"),
    b: fingerprinter.admissionKey("sk-secret-b"),
    c: fingerprinter.admissionKey("sk-secret-c"),
  };
}

describe("rate-limit principal fingerprints", () => {
  test("is deterministic, keyed, domain-separated, and non-reversible", () => {
    const first = new PrincipalFingerprinter(SECRET_A);
    const same = new PrincipalFingerprinter(SECRET_A);
    const otherSecret = new PrincipalFingerprinter(SECRET_B);

    const admission = first.admissionKey("low-entropy-principal");
    const management = first.management("low-entropy-principal");

    expect(admission).toEqual(same.admissionKey("low-entropy-principal"));
    expect(admission.fingerprint).not.toBe(otherSecret.admissionKey("low-entropy-principal").fingerprint);
    expect(admission.fingerprint).not.toBe(management.fingerprint);
    expect(admission.fingerprint).not.toContain("low-entropy-principal");
    expect(admission.fingerprint.startsWith("admission-key:")).toBe(true);
    expect(first.anonymous()).toEqual(first.anonymous());
  });

  test("rejects weak secrets, empty values, and oversized principals", () => {
    expect(() => new PrincipalFingerprinter(new Uint8Array(31))).toThrow("at least 32 bytes");
    const fingerprinter = new PrincipalFingerprinter(SECRET_A);
    expect(() => fingerprinter.admissionKey("")).toThrow("must not be empty");
    expect(() => fingerprinter.remoteAddress("x".repeat(16 * 1024 + 1))).toThrow("exceeds");
  });
});

describe("atomic token buckets", () => {
  test("allows burst, blocks excess, and returns integer retry metadata", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({ now: () => now });
    const { a } = principals();
    const policy = { requestsPerMinute: 60, burst: 2 };

    expect(limiter.consume("responses-http", a, policy)).toMatchObject({
      allowed: true,
      source: "principal",
      limit: 2,
      remaining: 1,
      retryAfterSeconds: 0,
    });
    expect(limiter.consume("responses-http", a, policy)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    const denied = limiter.consume("responses-http", a, policy);
    expect(denied).toMatchObject({
      allowed: false,
      reason: "rate_limited",
      remaining: 0,
      retryAfterSeconds: 1,
    });
    expect(Number.isInteger(denied.retryAfterSeconds)).toBe(true);
    expect(Number.isInteger(denied.resetAfterSeconds)).toBe(true);

    now = 1_000;
    expect(limiter.consume("responses-http", a, policy)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
  });

  test("isolates principals and surfaces", () => {
    const limiter = new TokenBucketLimiter({ now: () => 0 });
    const { a, b } = principals();
    const policy = { requestsPerMinute: 1, burst: 1 };

    expect(limiter.consume("images", a, policy).allowed).toBe(true);
    expect(limiter.consume("images", a, policy).allowed).toBe(false);
    expect(limiter.consume("images", b, policy).allowed).toBe(true);
    expect(limiter.consume("search", a, policy).allowed).toBe(true);
    expect(limiter.bucketCounts()).toEqual({ principals: 3, overflowSurfaces: 0 });
  });

  test("does not mint tokens when the sampled clock moves backwards", () => {
    let now = 10_000;
    const limiter = new TokenBucketLimiter({ now: () => now });
    const { a } = principals();
    const policy = { requestsPerMinute: 60, burst: 1 };

    expect(limiter.consume("management", a, policy).allowed).toBe(true);
    now = 5_000;
    expect(limiter.consume("management", a, policy).allowed).toBe(false);
    now = 11_000;
    expect(limiter.consume("management", a, policy).allowed).toBe(true);
  });

  test("evicts the oldest stale principal before using overflow", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({
      maxBuckets: 1,
      staleAfterMs: 1_000,
      now: () => now,
    });
    const { a, b } = principals();
    const policy = { requestsPerMinute: 1, burst: 1 };

    expect(limiter.consume("live", a, policy).source).toBe("principal");
    now = 1_000;
    expect(limiter.consume("live", b, policy).source).toBe("principal");
    expect(limiter.bucketCounts()).toEqual({ principals: 1, overflowSurfaces: 0 });
  });

  test("charges new principals to a bounded shared overflow bucket at hard cap", () => {
    const limiter = new TokenBucketLimiter({
      maxBuckets: 1,
      staleAfterMs: 60_000,
      now: () => 0,
    });
    const { a, b, c } = principals();
    const policy = { requestsPerMinute: 1, burst: 1 };

    expect(limiter.consume("chat-completions", a, policy)).toMatchObject({
      allowed: true,
      source: "principal",
    });
    expect(limiter.consume("chat-completions", b, policy)).toMatchObject({
      allowed: true,
      source: "overflow",
    });
    expect(limiter.consume("chat-completions", c, policy)).toMatchObject({
      allowed: false,
      source: "overflow",
      reason: "rate_limited",
    });
    expect(limiter.bucketCounts()).toEqual({ principals: 1, overflowSurfaces: 1 });
    expect(limiter.statsSnapshot()).toEqual([
      { surface: "chat-completions", source: "overflow", result: "allowed", count: 1 },
      { surface: "chat-completions", source: "overflow", result: "denied", count: 1 },
      { surface: "chat-completions", source: "principal", result: "allowed", count: 1 },
    ]);
  });

  test("validates policy, cost, and capacity settings", () => {
    expect(() => validateRateLimitPolicy({ requestsPerMinute: 0, burst: 1 })).toThrow("requestsPerMinute");
    expect(() => validateRateLimitPolicy({ requestsPerMinute: 1, burst: 0 })).toThrow("burst");
    expect(() => new TokenBucketLimiter({ maxBuckets: 0 })).toThrow("maxBuckets");
    expect(() => new TokenBucketLimiter({ staleAfterMs: 0 })).toThrow("staleAfterMs");
    const { a } = principals();
    const limiter = new TokenBucketLimiter();
    expect(() => limiter.consume("images", a, { requestsPerMinute: 1, burst: 1 }, 0)).toThrow("cost");
  });
});

describe("WebSocket concurrency reservations", () => {
  test("enforces per-principal caps and releases idempotently", () => {
    const limiter = new WebSocketConcurrencyLimiter();
    const { a } = principals();
    const limits = { perPrincipal: 2, global: 10 };

    const first = limiter.reserve(a, limits);
    const second = limiter.reserve(a, limits);
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    expect(limiter.reserve(a, limits)).toMatchObject({
      accepted: false,
      reason: "principal_limit",
      principalCount: 2,
    });

    if (!first.accepted) throw new Error("expected accepted reservation");
    first.release();
    first.release();
    expect(limiter.snapshot()).toMatchObject({ globalCount: 1, trackedPrincipals: 1 });
    expect(limiter.reserve(a, limits).accepted).toBe(true);
  });

  test("enforces the global cap before completing another handshake", () => {
    const limiter = new WebSocketConcurrencyLimiter();
    const { a, b } = principals();
    const limits = { perPrincipal: 5, global: 1 };

    expect(limiter.reserve(a, limits).accepted).toBe(true);
    expect(limiter.reserve(b, limits)).toMatchObject({
      accepted: false,
      reason: "global_limit",
      globalCount: 1,
    });
  });

  test("fails closed when principal tracking is at capacity", () => {
    const limiter = new WebSocketConcurrencyLimiter({ maxTrackedPrincipals: 1 });
    const { a, b } = principals();
    const limits = { perPrincipal: 5, global: 10 };

    const first = limiter.reserve(a, limits);
    expect(first.accepted).toBe(true);
    expect(limiter.reserve(b, limits)).toMatchObject({
      accepted: false,
      reason: "principal_capacity",
    });

    if (!first.accepted) throw new Error("expected accepted reservation");
    first.release();
    expect(limiter.reserve(b, limits).accepted).toBe(true);
  });

  test("ignores stale release handles issued before a reset", () => {
    const limiter = new WebSocketConcurrencyLimiter();
    const { a, b } = principals();
    const limits = { perPrincipal: 2, global: 10 };

    const stale = limiter.reserve(a, limits);
    if (!stale.accepted) throw new Error("expected accepted reservation");
    limiter.reset();

    expect(limiter.reserve(b, limits).accepted).toBe(true);
    expect(limiter.reserve(a, limits).accepted).toBe(true);
    stale.release();
    expect(limiter.snapshot()).toMatchObject({ globalCount: 2, trackedPrincipals: 2 });
  });

  test("validates limits and exposes aggregate-only statistics", () => {
    const limiter = new WebSocketConcurrencyLimiter({ maxTrackedPrincipals: 1 });
    const { a } = principals();
    expect(() => limiter.reserve(a, { perPrincipal: 0, global: 1 })).toThrow("perPrincipal");
    expect(() => limiter.reserve(a, { perPrincipal: 1, global: 0 })).toThrow("global");
    expect(() => new WebSocketConcurrencyLimiter({ maxTrackedPrincipals: 0 })).toThrow("maxTrackedPrincipals");

    const accepted = limiter.reserve(a, { perPrincipal: 1, global: 1 });
    expect(accepted.accepted).toBe(true);
    expect(limiter.reserve(a, { perPrincipal: 1, global: 1 }).accepted).toBe(false);
    expect(limiter.snapshot()).toEqual({
      globalCount: 1,
      trackedPrincipals: 1,
      stats: {
        accepted: 1,
        deniedGlobal: 1,
        deniedPrincipal: 0,
        deniedPrincipalCapacity: 0,
      },
    });
  });
});
