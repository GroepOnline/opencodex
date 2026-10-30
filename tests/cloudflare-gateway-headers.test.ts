import { afterEach, describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { applyCloudflareAiGatewayHeaders } from "../src/providers/cloudflare-gateway";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

afterEach(() => {
  delete process.env.OCX_CF_AIG_CACHE;
});

function parsed(): OcxParsedRequest {
  return {
    modelId: "claude-haiku-4-5",
    context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    stream: false,
    options: {},
  };
}

function provider(
  baseUrl: string,
  headers?: Record<string, string>,
): OcxProviderConfig {
  return {
    adapter: "anthropic",
    baseUrl,
    apiKey: "sk-test",
    authMode: "key",
    ...(headers ? { headers } : {}),
  };
}

describe("Cloudflare AI Gateway cache headers", () => {
  test("skips gateway caching for prompt-bearing requests by default", () => {
    const headers: Record<string, string> = {};
    applyCloudflareAiGatewayHeaders(
      headers,
      "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic",
    );
    expect(headers["cf-aig-skip-cache"]).toBe("true");
  });

  test("leaves other hosts and an explicit operator cache opt-in alone", () => {
    const other: Record<string, string> = {};
    applyCloudflareAiGatewayHeaders(other, "https://api.anthropic.com");
    expect(other).toEqual({});
    process.env.OCX_CF_AIG_CACHE = "1";
    const opted: Record<string, string> = {};
    applyCloudflareAiGatewayHeaders(
      opted,
      "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic",
    );
    expect(opted).toEqual({});
  });

  test("does not override an explicit cache header", () => {
    const headers = { "cf-aig-cache-key": "catalog" };
    applyCloudflareAiGatewayHeaders(
      headers,
      "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic",
    );
    expect(headers).toEqual({ "cf-aig-cache-key": "catalog" });
  });

  test("the Anthropic adapter sends skip-cache to a resolved gateway URL", async () => {
    const adapter = createAnthropicAdapter(
      provider(
        "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic",
      ),
    );
    const request = await adapter.buildRequest(parsed());
    expect(request.headers?.["cf-aig-skip-cache"]).toBe("true");
  });

  test("a saved provider header still wins", async () => {
    const adapter = createAnthropicAdapter(
      provider(
        "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic",
        { "cf-aig-skip-cache": "false" },
      ),
    );
    const request = await adapter.buildRequest(parsed());
    expect(request.headers?.["cf-aig-skip-cache"]).toBe("false");
  });
});
