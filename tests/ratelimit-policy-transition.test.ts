import { describe, expect, test } from "bun:test";
import { PrincipalFingerprinter, TokenBucketLimiter } from "../src/ratelimit";

const SECRET = new Uint8Array(32).fill(0x33);

function testPrincipals() {
  const fingerprinter = new PrincipalFingerprinter(SECRET);
  return {
    a: fingerprinter.admissionKey("policy-transition-a"),
    b: fingerprinter.admissionKey("policy-transition-b"),
    c: fingerprinter.admissionKey("policy-transition-c"),
  };
}

describe("token-bucket policy transitions", () => {
  test("low-to-high changes do not retroactively refill elapsed time at the new rate", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({ now: () => now });
    const { a } = testPrincipals();
    const low = { requestsPerMinute: 1, burst: 1 };
    const high = { requestsPerMinute: 600, burst: 10 };

    expect(limiter.consume("responses-http", a, low).allowed).toBe(true);
    now = 10_000;

    const transitioned = limiter.consume("responses-http", a, high);
    expect(transitioned).toMatchObject({
      allowed: false,
      limit: 10,
      remaining: 0,
      reason: "rate_limited",
    });
  });

  test("high-to-low changes preserve refill earned under the prior policy before clamping", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({ now: () => now });
    const { a } = testPrincipals();
    const high = { requestsPerMinute: 600, burst: 10 };
    const low = { requestsPerMinute: 1, burst: 1 };

    for (let i = 0; i < high.burst; i += 1) {
      expect(limiter.consume("responses-http", a, high).allowed).toBe(true);
    }
    expect(limiter.consume("responses-http", a, high).allowed).toBe(false);

    now = 1_000;
    expect(limiter.consume("responses-http", a, low)).toMatchObject({
      allowed: true,
      limit: 1,
      remaining: 0,
    });
  });

  test("raising burst capacity does not mint free tokens", () => {
    const limiter = new TokenBucketLimiter({ now: () => 0 });
    const { a } = testPrincipals();

    expect(limiter.consume("images", a, { requestsPerMinute: 60, burst: 1 }).allowed).toBe(true);
    expect(limiter.consume("images", a, { requestsPerMinute: 60, burst: 10 })).toMatchObject({
      allowed: false,
      limit: 10,
      remaining: 0,
    });
  });

  test("lowering burst capacity clamps the existing balance before admission", () => {
    const limiter = new TokenBucketLimiter({ now: () => 0 });
    const { a } = testPrincipals();

    expect(limiter.consume("search", a, { requestsPerMinute: 60, burst: 10 })).toMatchObject({
      allowed: true,
      remaining: 9,
    });
    expect(limiter.consume("search", a, { requestsPerMinute: 60, burst: 2 })).toMatchObject({
      allowed: true,
      limit: 2,
      remaining: 1,
    });
  });

  test("shared overflow buckets use the same explicit policy transition", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({
      maxBuckets: 1,
      staleAfterMs: 60_000,
      now: () => now,
    });
    const { a, b, c } = testPrincipals();
    const low = { requestsPerMinute: 1, burst: 1 };
    const high = { requestsPerMinute: 600, burst: 10 };

    expect(limiter.consume("chat-completions", a, low).source).toBe("principal");
    expect(limiter.consume("chat-completions", b, low)).toMatchObject({
      allowed: true,
      source: "overflow",
    });

    now = 10_000;
    expect(limiter.consume("chat-completions", c, high)).toMatchObject({
      allowed: false,
      source: "overflow",
      limit: 10,
    });
  });
});
