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
      models: ["Qwen/Qwen3.8-Flash-Next-FP8"],
    });
    expect(
      PROVIDER_REGISTRY.some((provider) => provider.id === "empero-free"),
    ).toBe(false);
  });

  test("pins the provider-use restrictions in operator-visible metadata", () => {
    const note = entry?.note?.toLowerCase() ?? "";
    expect(note).toContain("datacenter");
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
