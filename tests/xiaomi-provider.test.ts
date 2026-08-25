import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { KEY_LOGIN_PROVIDERS } from "../src/oauth/key-providers";
import { deriveJawcodeAliases, deriveProviderPresets } from "../src/providers/derive";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { routeModel } from "../src/router";
import type { OcxConfig } from "../src/types";

const PAYG_URL = "https://api.xiaomimimo.com/v1";
const TOKEN_PLAN_URL = "https://token-plan-cn.xiaomimimo.com/v1";

function xiaomiConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "xiaomi",
    providers: {
      xiaomi: {
        adapter: "openai-chat",
        baseUrl: PAYG_URL,
        apiKey: "test-key",
      },
    },
  };
}

async function buildBody(modelRef: string, reasoning: string): Promise<Record<string, unknown>> {
  const route = routeModel(xiaomiConfig(), modelRef);
  const adapter = createOpenAIChatAdapter(route.provider);
  const request = await adapter.buildRequest({
    modelId: route.modelId,
    context: { messages: [{ role: "user", content: "hi" }] },
    stream: true,
    options: { reasoning },
  });
  return JSON.parse(request.body as string) as Record<string, unknown>;
}

describe("Xiaomi MiMo provider", () => {
  test("publishes the pay-as-you-go OpenAI chat contract", () => {
    const entry = PROVIDER_REGISTRY.find(provider => provider.id === "xiaomi");
    expect(entry).toMatchObject({
      label: "Xiaomi MiMo",
      baseUrl: PAYG_URL,
      adapter: "openai-chat",
      authKind: "key",
      featured: true,
      dashboardUrl: "https://platform.xiaomimimo.com",
      defaultModel: "mimo-v2.5-pro",
      jawcodeBundle: "xiaomi",
      liveModels: false,
    });
    expect(entry?.models).toEqual(["mimo-v2.5-pro", "mimo-v2.5"]);
    expect(entry?.modelContextWindows?.["mimo-v2.5-pro"]).toBe(1_048_576);
    expect(entry?.modelContextWindows?.["mimo-v2.5"]).toBe(1_048_576);
    expect(entry?.modelMaxOutputTokens?.["mimo-v2.5-pro"]).toBe(131_072);
    expect(entry?.modelInputModalities?.["mimo-v2.5-pro"]).toEqual(["text"]);
    expect(entry?.modelInputModalities?.["mimo-v2.5"]).toEqual(["text", "image"]);
    expect(entry?.noVisionModels).toEqual(["mimo-v2.5-pro", "mimo-v2.5-pro-ultraspeed"]);
    expect(entry?.noVisionModels).not.toContain("mimo-v2.5");
    expect(entry?.thinkingToggleModels).toEqual(["mimo-v2.5-pro", "mimo-v2.5", "mimo-v2.5-pro-ultraspeed"]);
    expect(entry?.preserveReasoningContentModels).toContain("mimo-v2.5-pro");
  });

  test("pins a saved anthropic /anthropic row onto the OpenAI chat host", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "xiaomi",
      providers: {
        xiaomi: {
          adapter: "anthropic",
          baseUrl: "https://api.xiaomimimo.com/anthropic",
          apiKey: "sk-legacy",
        },
      },
    };
    const routed = routeModel(config, "xiaomi/mimo-v2.5-pro");
    expect(routed.provider.adapter).toBe("openai-chat");
    expect(routed.provider.baseUrl).toBe(PAYG_URL);
    expect(routed.provider.thinkingToggleModels).toContain("mimo-v2.5-pro");
  });

  test("keeps Token Plan on its own host and does not retarget pay-as-you-go keys", () => {
    const token = PROVIDER_REGISTRY.find(provider => provider.id === "xiaomi-token-plan");
    expect(token).toMatchObject({
      label: "Xiaomi MiMo Token Plan",
      baseUrl: TOKEN_PLAN_URL,
      adapter: "openai-chat",
      defaultModel: "mimo-v2.5-pro",
    });
    expect(token?.featured).toBeUndefined();

    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "xiaomi",
      providers: {
        xiaomi: { adapter: "openai-chat", baseUrl: PAYG_URL, apiKey: "sk-payg" },
        "xiaomi-token-plan": { adapter: "openai-chat", baseUrl: TOKEN_PLAN_URL, apiKey: "tp-plan" },
      },
    };
    expect(routeModel(config, "xiaomi/mimo-v2.5-pro").provider.baseUrl).toBe(PAYG_URL);
    expect(routeModel(config, "xiaomi-token-plan/mimo-v2.5-pro").provider.baseUrl).toBe(TOKEN_PLAN_URL);
  });

  test("maps reasoning effort onto Xiaomi thinking toggle instead of reasoning_effort", async () => {
    const high = await buildBody("xiaomi/mimo-v2.5-pro", "high");
    expect(high.thinking).toEqual({ type: "enabled" });
    expect(high.reasoning_effort).toBeUndefined();

    const low = await buildBody("xiaomi/mimo-v2.5-pro", "low");
    expect(low.thinking).toEqual({ type: "disabled" });
    expect(low.reasoning_effort).toBeUndefined();
  });

  test("derives key login, GUI preset, and metadata bundle from the registry", () => {
    expect(KEY_LOGIN_PROVIDERS.xiaomi).toMatchObject({
      label: "Xiaomi MiMo",
      adapter: "openai-chat",
      baseUrl: PAYG_URL,
      defaultModel: "mimo-v2.5-pro",
      liveModels: false,
    });
    expect(KEY_LOGIN_PROVIDERS["xiaomi-token-plan"]).toMatchObject({
      label: "Xiaomi MiMo Token Plan",
      adapter: "openai-chat",
      baseUrl: TOKEN_PLAN_URL,
    });
    expect(deriveProviderPresets().find(preset => preset.id === "xiaomi")).toMatchObject({
      auth: "key",
      defaultModel: "mimo-v2.5-pro",
    });
    expect(deriveJawcodeAliases().xiaomi).toBe("xiaomi");
    expect(deriveJawcodeAliases()["xiaomi-token-plan"]).toBe("xiaomi");
  });
});
