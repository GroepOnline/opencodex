import { describe, expect, test } from "bun:test";
import {
  buildDroidSettingsOverlay,
  droidCustomModelId,
} from "../src/cli/droid";
import type { OcxConfig } from "../src/types";

const cfg = {
  port: 10100,
  defaultProvider: "openai",
  providers: {
    openai: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:10100/v1" },
  },
} as OcxConfig;

const routed = [
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

describe("Factory 117-model compatibility fixture", () => {
  test("retains full identities, provider fields, nested metadata and settings values", () => {
    // This models Factory documented customModels id-keyed merge behavior.
    // Real installed-CLI acceptance is tracked separately from source tests.
    const existing = Array.from({ length: 117 }, (_, i) => ({
      id: "custom:baseline-" + i,
      index: i,
      model: "vendor-" + (i % 9) + "/model-" + i,
      displayName: "Existing model " + i,
      provider: i % 2 ? "openai" : "generic-chat-completion-api",
      baseUrl: "https://provider-" + i + ".example.invalid/v1",
      apiKey: "$" + "{TEST_KEY_" + i + "}",
      maxOutputTokens: 4096 + i,
      noImageSupport: i % 3 === 0,
      extraArgs: {
        effort: i % 4,
        nested: { limits: [i, i * 2], enabled: i % 2 === 0 },
      },
      extraHeaders: { "X-Route": "synthetic-" + i },
      modelFallbacks: ["vendor/fallback-" + i],
    }));
    const before = structuredClone(existing);
    const overlay = buildDroidSettingsOverlay(cfg, 10100, routed);
    const merged = new Map<string, unknown>(
      existing.map((row) => [row.id, row]),
    );
    for (const row of overlay.customModels) {
      expect(merged.has(row.id)).toBe(false);
      merged.set(row.id, row);
    }
    expect(merged.size).toBe(119);
    for (const original of before) {
      expect(merged.get(original.id)).toStrictEqual(original);
    }
    expect(existing).toStrictEqual(before);
    expect(overlay.customModels).toHaveLength(2);
    expect(JSON.stringify(overlay)).not.toContain("TEST_KEY_");
  });

  test("uses stable explicit Factory model IDs despite renamed, reordered or duplicated proxy rows", () => {
    const first = buildDroidSettingsOverlay(cfg, 10100, routed);
    const reordered = buildDroidSettingsOverlay(cfg, 10100, [
      { ...routed[1]!, displayName: "Different display" },
      { ...routed[0]!, displayName: "Also different" },
      { ...routed[0]!, displayName: "Duplicate" },
    ]);
    expect(reordered.customModels).toHaveLength(2);
    for (const original of first.customModels) {
      expect(
        reordered.customModels.find((row) => row.model === original.model)?.id,
      ).toBe(original.id);
    }
    expect(first.model).toBe(droidCustomModelId(routed[0]!.id));
    expect(first.customModels[0]!.id).toStartWith("custom:ocx-");
    expect(droidCustomModelId("provider/a.b")).not.toBe(
      droidCustomModelId("provider/a-b"),
    );
  });
});
