import { describe, expect, test } from "bun:test";
import { FREE_PROVIDER_DIRECTORY } from "../src/providers/free-directory";
import { PROVIDER_REGISTRY } from "../src/providers/registry";

const entry = FREE_PROVIDER_DIRECTORY.find(
  (provider) => provider.id === "empero-free",
);

describe("Empero free discovery entry", () => {
  test("is catalogued without becoming a deployed first-class provider", () => {
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://free.empero.org/v1",
      keyOptional: true,
      supportLevel: "reference",
      verification: "primary",
      liveModels: false,
      models: ["glm-5.3-flash"],
    });
    expect(
      PROVIDER_REGISTRY.some((provider) => provider.id === "empero-free"),
    ).toBe(false);
  });

  test("pins the provider-use restrictions in operator-visible metadata", () => {
    const note = entry?.note?.toLowerCase() ?? "";
    expect(note).toContain("hashed ips");
    expect(note).toContain("private chefgroep");
    expect(note).toContain("logged");
    expect(note).toContain("training");
    expect(note).toContain("desktop/public benchmark only");
  });
});

describe("new free-provider discovery candidates", () => {
  test("catalogues InferX and OptraCloud without promoting runtime authority", () => {
    const inferx = FREE_PROVIDER_DIRECTORY.find(
      (provider) => provider.id === "inferx",
    );
    const optra = FREE_PROVIDER_DIRECTORY.find(
      (provider) => provider.id === "optracloud",
    );
    expect(inferx).toMatchObject({
      baseUrl: "https://model.inferx.net/endpoints/v1",
      discovery: "live",
      liveModels: true,
    });
    expect(optra).toMatchObject({
      baseUrl: "https://api.optracloud.com/v1",
      discovery: "live",
      liveModels: true,
    });
    expect(PROVIDER_REGISTRY.some((provider) => provider.id === "inferx")).toBe(
      false,
    );
    expect(
      PROVIDER_REGISTRY.some((provider) => provider.id === "optracloud"),
    ).toBe(false);
  });

  test("keeps privacy and jurisdiction caveats visible", () => {
    const inferx = FREE_PROVIDER_DIRECTORY.find(
      (provider) => provider.id === "inferx",
    );
    const optra = FREE_PROVIDER_DIRECTORY.find(
      (provider) => provider.id === "optracloud",
    );
    expect(inferx?.note?.toLowerCase()).toContain("residency");
    expect(optra?.note?.toLowerCase()).toContain("india");
    expect(optra?.note?.toLowerCase()).toContain("public-only");
  });
});

describe("2026-08-28 inference supply candidates", () => {
  test("catalogues newly verified OpenAI-compatible endpoints", () => {
    const expected: Record<string, string> = {
      entrim: "https://api.entrim.ai/v1",
      freeinference: "https://freeinference.org/v1",
      flexai: "https://api.flex.ai/v1",
      "wandb-inference": "https://api.inference.wandb.ai/v1",
      "simplellm-eu": "https://api.simplellm.eu/v1",
      "ai-vps-cz": "https://ai.vps.cz/api/v1",
    };
    for (const [id, baseUrl] of Object.entries(expected)) {
      expect(
        FREE_PROVIDER_DIRECTORY.find((provider) => provider.id === id),
      ).toMatchObject({ adapter: "openai-chat", baseUrl });
      expect(PROVIDER_REGISTRY.some((provider) => provider.id === id)).toBe(
        false,
      );
    }
  });

  test("keeps sensitive-use caveats attached to research and unverified-retention routes", () => {
    const freeInference = FREE_PROVIDER_DIRECTORY.find(
      (provider) => provider.id === "freeinference",
    );
    const flex = FREE_PROVIDER_DIRECTORY.find(
      (provider) => provider.id === "flexai",
    );
    const simple = FREE_PROVIDER_DIRECTORY.find(
      (provider) => provider.id === "simplellm-eu",
    );
    expect(freeInference?.note?.toLowerCase()).toContain("public-only");
    expect(freeInference?.note?.toLowerCase()).toContain("logged");
    expect(flex?.note?.toLowerCase()).toContain("retention");
    expect(simple?.note?.toLowerCase()).toContain("zero retention");
  });

  test("keeps Aelius visible as reference-only because its current API is not OpenAI chat-completions compatible", () => {
    const aelius = FREE_PROVIDER_DIRECTORY.find(
      (provider) => provider.id === "aelius",
    );
    expect(aelius).toMatchObject({
      supportLevel: "reference",
      verification: "unverified",
      discovery: "unsupported",
      liveModels: false,
    });
    expect(aelius?.baseUrl).toBe("");
  });
});
