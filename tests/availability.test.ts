import { describe, expect, test } from "bun:test";
import { classifyAttempt, hopChainTargets, isAccountPoolHopStatus, selectHopChain } from "../src/availability";
import type { OcxConfig } from "../src/types";

function baseConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: {
      a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"] },
      b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb", models: ["m2"] },
      c: { adapter: "openai-chat", baseUrl: "https://c.example/v1", apiKey: "kc", models: ["m3"] },
    },
    ...overrides,
  };
}

describe("classifyAttempt", () => {
  test("surfaces 499 and context overflows", () => {
    expect(classifyAttempt({ status: 499, message: "cancelled" })).toBe("surface");
    expect(classifyAttempt({ status: 400, message: "too long", code: "context_length_exceeded" })).toBe("surface");
  });

  test("hops 429, 529, and 5xx", () => {
    expect(classifyAttempt({ status: 429, message: "rate" })).toBe("hop");
    expect(classifyAttempt({ status: 529, message: "overloaded" })).toBe("hop");
    expect(classifyAttempt({ status: 503, message: "unavailable" })).toBe("hop");
  });
});

describe("isAccountPoolHopStatus", () => {
  test("only 429 and 529 rotate credential pools", () => {
    expect(isAccountPoolHopStatus(429)).toBe(true);
    expect(isAccountPoolHopStatus(529)).toBe(true);
    expect(isAccountPoolHopStatus(503)).toBe(false);
  });
});

describe("selectHopChain", () => {
  test("returns the routed target first, then fallback providers", () => {
    const config = baseConfig();
    config.providers.a!.fallback = [{ provider: "b", model: "m2" }, { provider: "c", model: "m3" }];
    const chain = selectHopChain(config, { provider: "a", modelId: "m1" });
    expect(chain).not.toBeNull();
    expect(chain!.preservePhysicalIdentity).toBe(true);
    expect(hopChainTargets(chain!).map(({ provider, model }) => ({ provider, model }))).toEqual([
      { provider: "a", model: "m1" },
      { provider: "b", model: "m2" },
      { provider: "c", model: "m3" },
    ]);
    expect(config.combos).toBeUndefined();
  });

  test("is null when there is no fallback list", () => {
    expect(selectHopChain(baseConfig(), { provider: "a", modelId: "m1" })).toBeNull();
  });

  test("is null when every fallback provider is disabled", () => {
    const config = baseConfig();
    config.providers.a!.fallback = [{ provider: "b", model: "m2" }];
    config.providers.b!.disabled = true;
    expect(selectHopChain(config, { provider: "a", modelId: "m1" })).toBeNull();
  });
});
