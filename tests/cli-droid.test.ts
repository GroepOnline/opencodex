import { describe, expect, test } from "bun:test";
import {
  buildDroidSettingsOverlay,
  droidBaseUrl,
  droidModelId,
  type DroidRoutedModel,
} from "../src/cli/droid";
import type { OcxConfig } from "../src/types";

function cfg(extra?: Partial<OcxConfig>): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: { openai: { adapter: "openai-chat", baseUrl: "http://x/v1" } },
    ...extra,
  } as OcxConfig;
}

const MODELS: DroidRoutedModel[] = [
  {
    provider: "openai",
    id: "openai/gpt-6-astra",
    displayName: "OCX / GPT-6 Astra",
  },
  {
    provider: "zai",
    id: "zai/glm-5.3-flash",
    displayName: "OCX / GLM-5.3 Flash",
  },
];

describe("ocx droid routed model selectors", () => {
  test("preserves provider namespaces for correct proxy routing", () => {
    expect(droidModelId("openai/gpt-6-astra")).toBe("openai/gpt-6-astra");
    expect(droidModelId("zai/glm-5.3-flash")).toBe("zai/glm-5.3-flash");
  });
  test("passes through a bare model id unchanged", () => {
    expect(droidModelId("gpt-5.5")).toBe("gpt-5.5");
  });
  test("preserves nested routing selectors", () => {
    expect(droidModelId("cline-pass/anthropic/claude-haiku-5.5")).toBe(
      "cline-pass/anthropic/claude-haiku-5.5",
    );
  });
});

describe("ocx droid base url", () => {
  test("defaults to the loopback Responses endpoint", () => {
    expect(droidBaseUrl(10123)).toBe("http://127.0.0.1:10123/v1");
  });
  test("uses an explicit origin and strips a trailing slash", () => {
    expect(droidBaseUrl(10100, "https://ocx.chefgroep.online/")).toBe(
      "https://ocx.chefgroep.online/v1",
    );
  });
});

describe("ocx droid settings overlay (non-destructive BYOK)", () => {
  test("emits one OpenAI-row per routed proxy model with the reduced model id", () => {
    const overlay = buildDroidSettingsOverlay(cfg(), 10123, MODELS);
    expect(overlay.customModels).toHaveLength(2);
    expect(overlay.customModels.map((row) => row.model)).toEqual([
      "openai/gpt-6-astra",
      "zai/glm-5.3-flash",
    ]);
    expect(
      overlay.customModels.every(
        (row) => row.baseUrl === "http://127.0.0.1:10123/v1",
      ),
    ).toBe(true);
    expect(overlay.customModels.every((row) => row.provider === "openai")).toBe(
      true,
    );
  });

  test("never embeds a literal secret: default key is an env reference", () => {
    const overlay = buildDroidSettingsOverlay(cfg(), 10123, MODELS);
    expect(overlay.customModels[0].apiKey).toBe("${OCX_ADMISSION_TOKEN}");
  });

  test("prefers config.injectionModel when it is present in the catalog", () => {
    const overlay = buildDroidSettingsOverlay(
      cfg({ injectionModel: "zai/glm-5.3-flash" }),
      10123,
      MODELS,
    );
    expect(overlay.model).toBe("zai/glm-5.3-flash");
  });

  test("falls back to the first row when injectionModel is not in the catalog", () => {
    const overlay = buildDroidSettingsOverlay(
      cfg({ injectionModel: "openai/gpt-5.5" }),
      10123,
      MODELS,
    );
    expect(overlay.model).toBe("openai/gpt-6-astra");
  });

  test("drops empty ids and synthesizes a display name when none is given", () => {
    const overlay = buildDroidSettingsOverlay(cfg(), 10123, [
      { provider: "openai", id: "" },
      { provider: "openai", id: "openai/gpt-6-luna" },
    ]);
    expect(overlay.customModels).toHaveLength(1);
    expect(overlay.customModels[0].displayName).toBe("OCX / openai/gpt-6-luna");
  });

  test("an empty catalog yields an empty table without throwing (preserves user file)", () => {
    const overlay = buildDroidSettingsOverlay(cfg(), 10123, []);
    expect(overlay.customModels).toEqual([]);
    expect(overlay.model).toBe("");
  });

  test("the overlay carries only model rows — never the user's full settings object", () => {
    const overlay = buildDroidSettingsOverlay(cfg(), 10123, MODELS) as Record<
      string,
      unknown
    >;
    expect(Object.keys(overlay).sort()).toEqual(["customModels", "model"]);
  });
});
