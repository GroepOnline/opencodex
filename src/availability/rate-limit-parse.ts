/**
 * Provider-specific rate-limit parsing (Fase C — "pooling goed voor elke provider").
 *
 * Each provider signals 429/529/cap exhaustion differently. This module centralizes the
 * header-shape knowledge so the core failover/cooldown logic never hard-codes per-vendor
 * quirks. Adapters expose the same shape via `ProviderAdapter.rateLimitFromHeaders`; this
 * file is the pure, testable implementation the adapters delegate to.
 *
 * Supported signals:
 * - Anthropic: `anthropic-ratelimit-*` (requests/tokens remaining + reset-epoch), and the
 *   per-account spend cap which arrives as 429 with NO retry-after and `*-remaining: 0`
 *   (must NOT rotate-retry — it's a hard credit/usage cap, not a window exhaustion).
 * - OpenAI / OpenRouter / most OpenAI-compatible: `x-ratelimit-remaining-*` + `retry-after`.
 * - Fallback: generic `retry-after` + status-code policy (429/529 retryable).
 */

import type { AdapterRateLimitInfo } from "../adapters/base";

function parseIntHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Anthropic rate-limit signaling (see https://docs.anthropic.com/rate-limits). */
export function parseAnthropicRateLimit(status: number, headers: Headers): AdapterRateLimitInfo | null {
  const retryAfter = headers.get("retry-after");
  const requestsRemaining = parseIntHeader(headers, "anthropic-ratelimit-requests-remaining");
  const tokensRemaining = parseIntHeader(headers, "anthropic-ratelimit-tokens-remaining");
  const hasAnthropicSignal = requestsRemaining !== null || tokensRemaining !== null
    || headers.has("anthropic-ratelimit-requests-limit")
    || headers.has("anthropic-ratelimit-tokens-limit");

  if (status === 529) {
    return {
      retryable: true,
      retryAfterSec: retryAfter ? parseRetryAfterToSec(retryAfter) : null,
      overload: true,
      requestsRemaining,
      tokensRemaining,
    };
  }

  if (status === 429) {
    // Per-account spend/credit cap: 429 WITHOUT a retry-after and the window fully exhausted.
    // This is a hard cap — rotating the key will not help and must NOT be retried.
    const noRetry = retryAfter === null;
    const exhaustedWindow = requestsRemaining !== null && requestsRemaining <= 0;
    if (noRetry && exhaustedWindow) {
      return {
        retryable: false,
        hardCap: true,
        retryAfterSec: null,
        requestsRemaining,
        tokensRemaining,
      };
    }
    return {
      retryable: true,
      retryAfterSec: retryAfter ? parseRetryAfterToSec(retryAfter) : null,
      requestsRemaining,
      tokensRemaining,
    };
  }

  if (status === 402) {
    // Account/billing exhausted — cool the attempted key, do not rotate-endlessly.
    return { retryable: false, hardCap: true, retryAfterSec: null, requestsRemaining, tokensRemaining };
  }

  if (!hasAnthropicSignal) return null;
  return { retryable: false, requestsRemaining, tokensRemaining };
}

/** OpenAI / OpenAI-compatible rate-limit signaling. */
export function parseOpenAIRateLimit(status: number, headers: Headers): AdapterRateLimitInfo | null {
  const retryAfter = headers.get("retry-after");
  const requestsRemaining = parseIntHeader(headers, "x-ratelimit-remaining-requests");
  const tokensRemaining = parseIntHeader(headers, "x-ratelimit-remaining-tokens");
  const hasSignal = requestsRemaining !== null || tokensRemaining !== null || retryAfter !== null;

  if (status === 429 || status === 529) {
    return {
      retryable: true,
      retryAfterSec: retryAfter ? parseRetryAfterToSec(retryAfter) : null,
      overload: status === 529,
      requestsRemaining,
      tokensRemaining,
    };
  }
  if (status === 402) {
    return { retryable: false, hardCap: true, retryAfterSec: null, requestsRemaining, tokensRemaining };
  }
  if (!hasSignal) return null;
  return { retryable: false, requestsRemaining, tokensRemaining };
}

/** Generic fallback: honors `retry-after` and treats 429/529 as retryable. */
export function parseGenericRateLimit(status: number, headers: Headers): AdapterRateLimitInfo | null {
  const retryAfter = headers.get("retry-after");
  if (status === 429 || status === 529) {
    return {
      retryable: true,
      retryAfterSec: retryAfter ? parseRetryAfterToSec(retryAfter) : null,
      overload: status === 529,
    };
  }
  if (status === 402) {
    return { retryable: false, hardCap: true, retryAfterSec: null };
  }
  if (retryAfter === null) return null;
  return { retryable: true, retryAfterSec: parseRetryAfterToSec(retryAfter) };
}

/**
 * Parse rate-limit info for a given provider adapter. Returns null when the provider is
 * unknown or the response carries no rate-limit signal (caller applies generic policy).
 */
export function parseProviderRateLimit(
  providerId: string,
  status: number,
  headers: Headers,
): AdapterRateLimitInfo | null {
  const id = providerId.toLowerCase();
  if (id.includes("anthropic")) return parseAnthropicRateLimit(status, headers);
  if (id.includes("openai") || id.includes("openrouter") || id.includes("azure")) {
    return parseOpenAIRateLimit(status, headers);
  }
  return parseGenericRateLimit(status, headers);
}

/**
 * Resolve the rate-limit signal for a failure, preferring the adapter's own
 * `rateLimitFromHeaders` (the per-provider seam) and falling back to the provider-id
 * dispatch. Used at every failover site so the cooldown math sees the real upstream
 * signal rather than a generic 429 default.
 */
export function rateLimitForFailure(
  providerName: string,
  status: number,
  headers: Headers,
  adapter?: { rateLimitFromHeaders?: (status: number, headers: Headers) => AdapterRateLimitInfo | null },
): AdapterRateLimitInfo | null {
  const fromAdapter = adapter?.rateLimitFromHeaders?.(status, headers);
  if (fromAdapter) return fromAdapter;
  return parseProviderRateLimit(providerName, status, headers);
}

/**
 * Parse a Retry-After value (seconds, or HTTP-date) into seconds from `now`.
 * Returns null when the value is absent or unparseable.
 */
export function parseRetryAfterToSec(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (!text) return null;
  // Seconds form.
  if (/^\d+$/.test(text)) {
    const sec = Number(text);
    return Number.isFinite(sec) ? sec : null;
  }
  // HTTP-date form.
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) {
    const delta = Math.round((parsed - now) / 1000);
    return delta > 0 ? delta : 0;
  }
  return null;
}
