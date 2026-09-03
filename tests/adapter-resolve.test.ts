/**
 * Issue #404: one OpenAI-compatible gateway can front models that speak different
 * wires. Grok needs the Responses API for hosted web_search; a sibling model on the
 * same provider is fine on chat completions. Without a per-model override the
 * provider-wide adapter wins and the hosted tool is dropped on the way out.
 */
import { describe, expect, test } from "bun:test";
import {
  resolveAdapter,
  resolveWireProtocolOverride,
} from "../src/server/adapter-resolve";
import type { OcxProviderConfig } from "../src/types";

function gateway(
  overrides: Partial<OcxProviderConfig> = {},
): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://gateway.example/v1",
    authMode: "key",
    apiKey: "test-key",
    ...overrides,
  } as OcxProviderConfig;
}

describe("per-model wire override (#404)", () => {
  test("selects the responses wire for the configured model only", () => {
    const provider = gateway({
      modelAdapters: { "grok-4.5": "openai-responses" },
    });

    expect(
      resolveWireProtocolOverride("localmodels", "grok-4.5", provider).adapter,
    ).toBe("openai-responses");
    // A sibling model on the same provider keeps the provider default.
    expect(
      resolveWireProtocolOverride("localmodels", "gemini-3-pro", provider)
        .adapter,
    ).toBe("openai-chat");
  });

  test("a provider without the field behaves exactly as before", () => {
    expect(
      resolveWireProtocolOverride("localmodels", "grok-4.5", gateway()).adapter,
    ).toBe("openai-chat");
  });

  test("does not mutate the provider it was given", () => {
    const provider = gateway({
      modelAdapters: { "grok-4.5": "openai-responses" },
    });
    const resolved = resolveWireProtocolOverride(
      "localmodels",
      "grok-4.5",
      provider,
    );

    expect(provider.adapter).toBe("openai-chat");
    // Credentials and destination must survive a wire swap untouched.
    expect(resolved.apiKey).toBe("test-key");
    expect(resolved.authMode).toBe("key");
    expect(resolved.baseUrl).toBe("https://gateway.example/v1");
  });

  test("a hard-pinned model ignores the override", () => {
    const provider = gateway({
      adapter: "openai-chat",
      modelAdapters: { "minimax-m3": "openai-chat" },
    });

    expect(
      resolveWireProtocolOverride("opencode-go", "minimax-m3", provider)
        .adapter,
    ).toBe("anthropic");
  });

  test("a pinned model survives a second resolve pass", () => {
    // The resolver runs twice per request (route time and adapter build). A pin check
    // phrased against the current adapter would pass the first time and then let the
    // override win on the second.
    const provider = gateway({
      modelAdapters: { "minimax-m3": "openai-chat" },
    });
    const once = resolveWireProtocolOverride(
      "opencode-go",
      "minimax-m3",
      provider,
    );
    const twice = resolveWireProtocolOverride(
      "opencode-go",
      "minimax-m3",
      once,
    );

    expect(once.adapter).toBe("anthropic");
    expect(twice.adapter).toBe("anthropic");
  });

  test("values outside the allowed wires are ignored at resolve time", () => {
    // Hand-edited config, or one written by a build that allowed more values.
    for (const disallowed of ["cursor", "kiro", "google", "anthropic"]) {
      const provider = gateway({ modelAdapters: { "grok-4.5": disallowed } });
      expect(
        resolveWireProtocolOverride("localmodels", "grok-4.5", provider)
          .adapter,
      ).toBe("openai-chat");
    }
  });

  test("a canonical forward provider never takes an override", () => {
    // The chat adapter only sends provider.apiKey, so switching wires here would drop
    // the caller's forwarded credential entirely.
    const forward = gateway({
      adapter: "openai-responses",
      authMode: "forward",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      modelAdapters: { "gpt-5.5": "openai-chat" },
    });

    expect(
      resolveWireProtocolOverride("openai", "gpt-5.5", forward).adapter,
    ).toBe("openai-responses");
  });
});

describe("Azure Responses endpoint compatibility", () => {
  test("normalizes automation_update for Kimi K2.7 on Azure Foundry", async () => {
    const adapter = resolveAdapter({
      adapter: "openai-responses",
      baseUrl: "https://example-resource.openai.azure.com/openai",
      authMode: "key",
      apiKey: "test-key",
    });
    const request = await adapter.buildRequest({
      modelId: "Kimi-K2.7-Code",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "Kimi-K2.7-Code",
        input: [],
        stream: true,
        tools: [
          {
            type: "namespace",
            name: "automations",
            tools: [
              {
                type: "function",
                name: "automation_update",
                parameters: {
                  oneOf: [
                    {
                      type: "object",
                      properties: { title: { type: "string" } },
                      required: ["title"],
                    },
                    {
                      type: "object",
                      properties: { is_enabled: { type: "boolean" } },
                      required: ["is_enabled"],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    });
    const body = JSON.parse(request.body) as {
      tools: Array<{ tools: Array<{ parameters: Record<string, unknown> }> }>;
    };
    const parameters = body.tools[0]?.tools[0]?.parameters;

    expect(parameters.type).toBe("object");
    for (const key of ["oneOf", "anyOf", "allOf", "enum", "const", "not"]) {
      expect(parameters[key]).toBeUndefined();
    }
    expect(parameters.properties).toEqual({
      title: { type: "string" },
      is_enabled: { type: "boolean" },
    });
    expect(parameters.required).toBeUndefined();
  });

  test("preserves allOf conjunction when branches constrain the same property", async () => {
    const adapter = resolveAdapter({
      adapter: "openai-responses",
      baseUrl: "https://example-resource.openai.azure.com/openai",
      authMode: "key",
      apiKey: "test-key",
    });
    const request = await adapter.buildRequest({
      modelId: "Kimi-K2.7-Code",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "Kimi-K2.7-Code",
        input: [],
        stream: true,
        tools: [
          {
            type: "function",
            name: "bounded_integer",
            parameters: {
              allOf: [
                {
                  type: "object",
                  properties: { value: { type: "integer", minimum: 1 } },
                },
                {
                  type: "object",
                  properties: { value: { type: "integer", maximum: 10 } },
                },
              ],
            },
          },
        ],
      },
    });
    const body = JSON.parse(request.body) as {
      tools: Array<{ parameters: { properties: Record<string, unknown> } }>;
    };

    expect(body.tools[0]?.parameters.properties.value).toEqual({
      allOf: [
        { type: "integer", minimum: 1 },
        { type: "integer", maximum: 10 },
      ],
    });
  });
  test("normalizes function schemas under additional_tools", async () => {
    const adapter = resolveAdapter({
      adapter: "openai-responses",
      baseUrl: "https://example-resource.openai.azure.com/openai",
      authMode: "key",
      apiKey: "test-key",
    });
    const request = await adapter.buildRequest({
      modelId: "Kimi-K2.7-Code",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "Kimi-K2.7-Code",
        input: [],
        stream: true,
        additional_tools: [
          {
            type: "function",
            name: "automation_update",
            parameters: {
              oneOf: [
                {
                  type: "object",
                  properties: { title: { type: "string" } },
                },
                {
                  type: "object",
                  properties: { is_enabled: { type: "boolean" } },
                },
              ],
            },
          },
        ],
      },
    });
    const body = JSON.parse(request.body) as {
      additional_tools: Array<{ parameters: Record<string, unknown> }>;
    };
    const parameters = body.additional_tools[0]?.parameters;

    expect(parameters.type).toBe("object");
    expect(parameters.oneOf).toBeUndefined();
    expect(parameters.properties).toEqual({
      title: { type: "string" },
      is_enabled: { type: "boolean" },
    });
  });
});
