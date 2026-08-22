/**
 * Adapter delegation of rate-limit parsing (Fase C).
 * Each adapter's `rateLimitFromHeaders` must delegate to the provider-specific parser so
 * the core failover logic reads a unified signal without re-implementing header shapes.
 */
import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { createResponsesPassthroughAdapter } from "../src/adapters/openai-responses";
import type { OcxProviderConfig } from "../src/types";

function prov(partial: Partial<OcxProviderConfig>): OcxProviderConfig {
  return { adapter: "openai-chat", baseUrl: "https://x/v1", models: ["m"], ...partial } as OcxProviderConfig;
}

function h(entries: Record<string, string>): Headers {
  const x = new Headers();
  for (const [k, v] of Object.entries(entries)) x.set(k, v);
  return x;
}

describe("adapter rateLimitFromHeaders delegation", () => {
  test("anthropic adapter delegates spend-cap parsing", () => {
    const a = createAnthropicAdapter(prov({}));
    const info = a.rateLimitFromHeaders!(429, h({
      "anthropic-ratelimit-requests-remaining": "0",
      "anthropic-ratelimit-tokens-remaining": "0",
    }));
    expect(info!.hardCap).toBe(true);
    expect(info!.retryable).toBe(false);
  });

  test("openai-chat adapter delegates retry-after parsing", () => {
    const a = createOpenAIChatAdapter(prov({}));
    const info = a.rateLimitFromHeaders!(429, h({ "retry-after": "15" }));
    expect(info!.retryAfterSec).toBe(15);
    expect(info!.retryable).toBe(true);
  });

  test("openai-responses adapter delegates overload parsing", () => {
    const a = createResponsesPassthroughAdapter(prov({}));
    const info = a.rateLimitFromHeaders!(529, h({}));
    expect(info!.overload).toBe(true);
    expect(info!.retryable).toBe(true);
  });
});
