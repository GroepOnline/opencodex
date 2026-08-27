import { describe, expect, test } from "bun:test";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import {
  deriveFeaturedProviderIds,
  deriveKeyLoginMap,
  providerConfigSeed,
} from "../src/providers/derive";

const entry = PROVIDER_REGISTRY.find(
  (provider) => provider.id === "tokenharbor",
);

describe("Token Harbor provider", () => {
  test("is a first-class OpenAI-compatible key provider with live catalog authority", () => {
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://tokenharbor.ai/v1",
      authKind: "key",
      freeTier: true,
      liveModels: true,
      preserveCustomDestination: true,
      defaultModel: "deepseek-v4-flash:free",
    });
  });

  test("uses only verified free ids as the offline fallback seed", () => {
    expect(entry?.models).toEqual([
      "deepseek-v4-flash:free",
      "mimo-v2.5:free",
      "qwen3.8-27b:free",
    ]);
    expect(entry?.modelContextWindows?.["deepseek-v4-flash:free"]).toBe(
      1_000_000,
    );
    expect(entry?.modelContextWindows?.["mimo-v2.5:free"]).toBe(1_048_576);
  });

  test("derives into key-login and featured provider surfaces", () => {
    expect(deriveKeyLoginMap().tokenharbor).toBeDefined();
    expect(deriveFeaturedProviderIds()).toContain("tokenharbor");
    expect(providerConfigSeed(entry!).liveModels).toBe(true);
    expect(providerConfigSeed(entry!).freeTier).toBe(true);
  });

  test("documents that permanent free routes are not privacy-safe by default", () => {
    const note = entry?.note?.toLowerCase() ?? "";
    expect(note).toContain("free routes");
    expect(note).toContain("public-only");
    expect(note).toContain("kater/cheffactory");
  });
});
