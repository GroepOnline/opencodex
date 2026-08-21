/**
 * Provider-specific rate-limit parsing (Fase C).
 * Covers Anthropic spend-cap (no-retry hard cap), OpenAI retry-after windows, and the
 * generic fallback policy — the knowledge the failover core consumes per provider.
 */
import { describe, expect, test } from "bun:test";
import {
  parseAnthropicRateLimit,
  parseOpenAIRateLimit,
  parseGenericRateLimit,
  parseProviderRateLimit,
  parseRetryAfterToSec,
} from "../src/availability/rate-limit-parse";

function headersOf(entries: Record<string, string>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(entries)) h.set(k, v);
  return h;
}

describe("parseAnthropicRateLimit", () => {
  test("429 with anthropic-ratelimit-* remaining is retryable, not a hard cap", () => {
    const info = parseAnthropicRateLimit(
      429,
      headersOf({ "anthropic-ratelimit-requests-remaining": "5", "anthropic-ratelimit-tokens-remaining": "1000" }),
    );
    expect(info).not.toBeNull();
    expect(info!.retryable).toBe(true);
    expect(info!.hardCap).toBeUndefined();
    expect(info!.requestsRemaining).toBe(5);
    expect(info!.tokensRemaining).toBe(1000);
  });

  test("429 with requests-remaining 0 and NO retry-after is a hard spend cap — must NOT rotate-retry", () => {
    const info = parseAnthropicRateLimit(
      429,
      headersOf({ "anthropic-ratelimit-requests-remaining": "0", "anthropic-ratelimit-tokens-remaining": "0" }),
    );
    expect(info).not.toBeNull();
    expect(info!.retryable).toBe(false);
    expect(info!.hardCap).toBe(true);
    expect(info!.retryAfterSec).toBeNull();
  });

  test("429 with both a retry-after and remaining 0 is a window exhaustion (retryable)", () => {
    const info = parseAnthropicRateLimit(
      429,
      headersOf({ "retry-after": "30", "anthropic-ratelimit-requests-remaining": "0" }),
    );
    expect(info!.retryable).toBe(true);
    expect(info!.hardCap).toBeUndefined();
    expect(info!.retryAfterSec).toBe(30);
  });

  test("529 overload is retryable + overload-flagged", () => {
    const info = parseAnthropicRateLimit(529, headersOf({ "retry-after": "5" }));
    expect(info!.retryable).toBe(true);
    expect(info!.overload).toBe(true);
    expect(info!.retryAfterSec).toBe(5);
  });

  test("402 is a hard cap with no retry", () => {
    const info = parseAnthropicRateLimit(402, headersOf({}));
    expect(info!.retryable).toBe(false);
    expect(info!.hardCap).toBe(true);
  });

  test("200 with only a limit header is not retryable", () => {
    const info = parseAnthropicRateLimit(
      200,
      headersOf({ "anthropic-ratelimit-requests-limit": "100" }),
    );
    expect(info!.retryable).toBe(false);
    expect(info!.requestsRemaining).toBeNull();
  });
});

describe("parseOpenAIRateLimit", () => {
  test("429 with retry-after is retryable and parses the window", () => {
    const info = parseOpenAIRateLimit(429, headersOf({ "retry-after": "12", "x-ratelimit-remaining-requests": "0" }));
    expect(info!.retryable).toBe(true);
    expect(info!.retryAfterSec).toBe(12);
    expect(info!.requestsRemaining).toBe(0);
  });

  test("529 is overload + retryable", () => {
    const info = parseOpenAIRateLimit(529, headersOf({}));
    expect(info!.retryable).toBe(true);
    expect(info!.overload).toBe(true);
  });

  test("402 is a hard cap", () => {
    const info = parseOpenAIRateLimit(402, headersOf({}));
    expect(info!.retryable).toBe(false);
    expect(info!.hardCap).toBe(true);
  });
});

describe("parseGenericRateLimit", () => {
  test("429 without provider signal is retryable via generic policy", () => {
    const info = parseGenericRateLimit(429, headersOf({}));
    expect(info!.retryable).toBe(true);
    expect(info!.overload).toBe(false);
  });

  test("429 with HTTP-date retry-after parses to a positive delta", () => {
    const future = new Date(Date.now() + 90_000).toUTCString();
    const info = parseGenericRateLimit(429, headersOf({ "retry-after": future }));
    expect(info!.retryAfterSec).toBeGreaterThan(0);
    expect(info!.retryable).toBe(true);
  });

  test("200 with no signal is null", () => {
    expect(parseGenericRateLimit(200, headersOf({}))).toBeNull();
  });
});

describe("parseProviderRateLimit dispatch", () => {
  test("anthropic id routes to Anthropic parser", () => {
    const info = parseProviderRateLimit(
      "anthropic",
      429,
      headersOf({ "anthropic-ratelimit-requests-remaining": "0", "anthropic-ratelimit-tokens-remaining": "0" }),
    );
    expect(info!.hardCap).toBe(true);
  });

  test("openai / openrouter / azure ids route to OpenAI parser", () => {
    for (const id of ["openai", "openrouter", "azure"]) {
      const info = parseProviderRateLimit(id, 429, headersOf({ "retry-after": "7" }));
      expect(info!.retryAfterSec).toBe(7);
    }
  });

  test("unknown provider falls back to generic policy", () => {
    const info = parseProviderRateLimit("groq", 529, headersOf({}));
    expect(info!.retryable).toBe(true);
    expect(info!.overload).toBe(true);
  });
});

describe("parseRetryAfterToSec", () => {
  test("bare seconds", () => {
    expect(parseRetryAfterToSec("60")).toBe(60);
    expect(parseRetryAfterToSec("0")).toBe(0);
  });
  test("null/empty", () => {
    expect(parseRetryAfterToSec(null)).toBeNull();
    expect(parseRetryAfterToSec("   ")).toBeNull();
  });
  test("http-date", () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    expect(parseRetryAfterToSec(future)).toBeGreaterThan(0);
  });
  test("garbage returns null", () => {
    expect(parseRetryAfterToSec("soon")).toBeNull();
  });
});
