import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { providerDestinationConfigError } from "../src/lib/destination-policy";
import {
  createUpstreamAttemptBudget,
  OCX_MAX_UPSTREAM_ATTEMPTS,
} from "../src/lib/upstream-attempt-budget";
import {
  OMNIROUTE_DOCKER_RUN,
  OMNIROUTE_LOOPBACK_BASE_URL,
  OMNIROUTE_PLACEHOLDER_API_KEY,
  resolveProviderCompat,
} from "../src/providers/compat";
import { enrichProviderFromRegistry, providerConfigSeed } from "../src/providers/derive";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { routeModel } from "../src/router";

function parsed(
  overrides: Partial<OcxParsedRequest> = {},
): OcxParsedRequest {
  return {
    modelId: "claude-sonnet-4-5-thinking",
    context: {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "lookup",
          description: "lookup",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      ],
    },
    stream: false,
    options: { reasoning: "high", maxOutputTokens: 128, promptCacheKey: "sess-1" },
    ...overrides,
  };
}

function bodyOf(provider: OcxProviderConfig, req?: OcxParsedRequest): Record<string, unknown> {
  const request = createOpenAIChatAdapter(provider).buildRequest(req ?? parsed());
  return JSON.parse(request.body as string) as Record<string, unknown>;
}

describe("provider compat metadata", () => {
  test("defaults resolve without requiring registry entries to set compat", () => {
    expect(resolveProviderCompat(undefined)).toEqual({
      thinkingFormat: "openai",
      sessionAffinity: "none",
      supportsStrictMode: false,
      maxTokensField: "max_tokens",
    });
  });

  test("existing capability lists still win over compat.thinkingFormat", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://example.test/v1",
      apiKey: "sk-test",
      thinkingToggleModels: ["toggle-model"],
      reasoningEffortMap: { high: "enabled", low: "disabled", medium: "enabled" },
      compat: { thinkingFormat: "openrouter" },
    };
    const body = bodyOf(provider, parsed({
      modelId: "toggle-model",
      options: { reasoning: "high", maxOutputTokens: 64 },
    }));
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  test("compat.thinkingFormat openrouter / qwen / max_completion_tokens apply when lists are empty", () => {
    const openrouter = bodyOf({
      adapter: "openai-chat",
      baseUrl: "https://example.test/v1",
      apiKey: "sk-test",
      compat: { thinkingFormat: "openrouter", maxTokensField: "max_completion_tokens" },
    });
    expect(openrouter.reasoning).toEqual({ effort: "high" });
    expect(openrouter.max_completion_tokens).toBe(128);
    expect(openrouter.max_tokens).toBeUndefined();
    expect(openrouter.reasoning_effort).toBeUndefined();

    const qwen = bodyOf({
      adapter: "openai-chat",
      baseUrl: "https://example.test/v1",
      apiKey: "sk-test",
      compat: { thinkingFormat: "qwen" },
    });
    expect(qwen.enable_thinking).toBe(true);
    expect(qwen.reasoning_effort).toBeUndefined();
  });

  test("compat.supportsStrictMode prefers strict when the tool omits it", () => {
    const tools = bodyOf({
      adapter: "openai-chat",
      baseUrl: "https://example.test/v1",
      apiKey: "sk-test",
      compat: { supportsStrictMode: true },
    }).tools as Array<{ function: { strict?: boolean } }>;
    expect(tools[0]?.function.strict).toBe(true);

    const explicitFalse = bodyOf(
      {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        apiKey: "sk-test",
        compat: { supportsStrictMode: true },
      },
      parsed({
        context: {
          messages: [{ role: "user", content: "hi" }],
          tools: [{
            name: "lookup",
            description: "lookup",
            parameters: { type: "object", properties: {} },
            strict: false,
          }],
        },
      }),
    ).tools as Array<{ function: { strict?: boolean } }>;
    expect(explicitFalse[0]?.function.strict).toBe(false);
  });

  test("compat.sessionAffinity prompt-cache-key and x-session-id", () => {
    const body = bodyOf({
      adapter: "openai-chat",
      baseUrl: "https://example.test/v1",
      apiKey: "sk-test",
      compat: { sessionAffinity: "prompt-cache-key" },
    });
    expect(body.prompt_cache_key).toBe("sess-1");

    const request = createOpenAIChatAdapter({
      adapter: "openai-chat",
      baseUrl: "https://example.test/v1",
      apiKey: "sk-test",
      compat: { sessionAffinity: "x-session-id" },
    }).buildRequest(parsed());
    expect(request.headers["X-Session-Id"]).toBe("sess-1");
    expect(JSON.parse(request.body as string).prompt_cache_key).toBeUndefined();
  });
});

describe("OmniRoute registry + loopback policy", () => {
  const entry = PROVIDER_REGISTRY.find(row => row.id === "omniroute");

  test("seeds compat matrix, keeps auto non-default, and does not rewrite free-model ids", () => {
    expect(entry).toBeDefined();
    expect(entry?.compat).toEqual({
      thinkingFormat: "openai",
      sessionAffinity: "none",
      supportsStrictMode: true,
      maxTokensField: "max_tokens",
    });
    expect(entry?.defaultModel).toBe("claude-sonnet-4-5-thinking");
    expect(entry?.defaultModel).not.toBe("auto");
    expect(entry?.models).toContain("auto");

    const seed = providerConfigSeed(entry!);
    expect(seed.compat).toEqual(entry!.compat);
    expect(seed.defaultModel).toBe("claude-sonnet-4-5-thinking");

    // No silent rewrite: free-tier siblings stay distinct providers.
    expect(PROVIDER_REGISTRY.find(row => row.id === "mimo-free")?.id).toBe("mimo-free");
    expect(PROVIDER_REGISTRY.find(row => row.id === "opencode-free")?.id).toBe("opencode-free");
    expect(entry?.models?.some(id => id.startsWith("mimo-") || id.startsWith("opencode-"))).toBe(false);
  });

  test("loopback self-host requires allowPrivateNetwork; placeholder bearer is documented", () => {
    expect(OMNIROUTE_LOOPBACK_BASE_URL).toBe("http://127.0.0.1:20128/v1");
    expect(OMNIROUTE_PLACEHOLDER_API_KEY).toBe("sk_omniroute");
    expect(OMNIROUTE_DOCKER_RUN).toContain("127.0.0.1:20128:20128");
    expect(OMNIROUTE_DOCKER_RUN).toContain("REQUIRE_API_KEY=false");

    expect(providerDestinationConfigError("omniroute", {
      baseUrl: OMNIROUTE_LOOPBACK_BASE_URL,
    })).toContain("allowPrivateNetwork");

    expect(providerDestinationConfigError("omniroute", {
      baseUrl: OMNIROUTE_LOOPBACK_BASE_URL,
      allowPrivateNetwork: true,
    })).toBeNull();

    // Cloud default stays public — no private-network flag required.
    expect(providerDestinationConfigError("omniroute", {
      baseUrl: entry!.baseUrl,
    })).toBeNull();
  });

  test("enrich backfills compat without overwriting user overrides", () => {
    const unset: OcxProviderConfig = { adapter: "openai-chat", baseUrl: entry!.baseUrl };
    enrichProviderFromRegistry("omniroute", unset);
    expect(unset.compat).toEqual(entry!.compat);

    const custom: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: entry!.baseUrl,
      compat: { thinkingFormat: "qwen", supportsStrictMode: false },
    };
    enrichProviderFromRegistry("omniroute", custom);
    expect(custom.compat).toEqual({ thinkingFormat: "qwen", supportsStrictMode: false });
  });

  test("routed omniroute/... models keep the provider namespace; nested retry stays in global budget", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "omniroute",
      providers: {
        omniroute: {
          adapter: "openai-chat",
          baseUrl: OMNIROUTE_LOOPBACK_BASE_URL,
          allowPrivateNetwork: true,
          apiKey: OMNIROUTE_PLACEHOLDER_API_KEY,
          defaultModel: "claude-sonnet-4-5-thinking",
        },
      },
    };
    const route = routeModel(config, "omniroute/claude-sonnet-4-5-thinking");
    expect(route.providerName).toBe("omniroute");
    expect(route.modelId).toBe("claude-sonnet-4-5-thinking");

    const auto = routeModel(config, "omniroute/auto");
    expect(auto.modelId).toBe("auto");
    expect(config.providers.omniroute?.defaultModel).not.toBe("auto");

    const budget = createUpstreamAttemptBudget();
    expect(OCX_MAX_UPSTREAM_ATTEMPTS).toBe(3);
    expect(budget.tryBegin()).toBe(true);
    expect(budget.tryBegin()).toBe(true);
    expect(budget.tryBegin()).toBe(true);
    expect(budget.tryBegin()).toBe(false);
    // OmniRoute-internal failover is one OCX attempt; OCX does not grant a higher budget.
    expect(budget.limit).toBe(OCX_MAX_UPSTREAM_ATTEMPTS);
  });
});
