import { describe, expect, test } from "bun:test";
import {
  buildDroidSettingsOverlay,
  droidAdmissionEnvironment,
  droidByokCompatibleModels,
} from "../src/cli/droid";
import type { OcxConfig } from "../src/types";

const config = {
  port: 10100,
  defaultProvider: "openai",
  providers: {
    openai: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:10100/v1" },
  },
} as OcxConfig;

describe("ocx droid secret-free data-plane admission", () => {
  test("forwards explicit OCX child credential as an env reference, never in the overlay", () => {
    const original = {
      OCX_ADMISSION_TOKEN: "explicit-data-plane-fixture",
      OPENCODEX_API_AUTH_TOKEN: "default-data-plane-fixture",
      OPENCODEX_ADMIN_AUTH_TOKEN: "management-token-must-not-leak",
    };
    const before = { ...original };
    const admission = droidAdmissionEnvironment(config, original);
    const overlay = buildDroidSettingsOverlay(
      config,
      10100,
      [{ provider: "zai", id: "zai/glm-5.3-flash" }],
      { apiKeyRef: admission.apiKeyRef },
    );
    expect(admission.apiKeyRef).toBe("${OCX_ADMISSION_TOKEN}");
    expect(admission.env.OCX_ADMISSION_TOKEN).toBe(
      original.OCX_ADMISSION_TOKEN,
    );
    expect(admission.env.OPENCODEX_ADMIN_AUTH_TOKEN).toBeUndefined();
    expect(original).toEqual(before);
    expect(JSON.stringify(overlay)).toContain("${OCX_ADMISSION_TOKEN}");
    expect(JSON.stringify(overlay)).not.toContain(
      "explicit-data-plane-fixture",
    );
    expect(JSON.stringify(overlay)).not.toContain(
      "management-token-must-not-leak",
    );
  });

  test("uses the standard OCX data-plane credential when explicit override is absent", () => {
    const original = {
      OPENCODEX_API_AUTH_TOKEN: "existing-data-plane-fixture",
      OPENCODEX_ADMIN_AUTH_TOKEN: "admin-is-not-data-plane",
    };
    const admission = droidAdmissionEnvironment(config, original);
    expect(admission.env.OCX_ADMISSION_TOKEN).toBe(
      "existing-data-plane-fixture",
    );
    expect(admission.apiKeyRef).toBe("${OCX_ADMISSION_TOKEN}");
    expect(original).not.toHaveProperty("OCX_ADMISSION_TOKEN");
  });

  test("never uses a management-only token to authenticate Factory inference", () => {
    const adminOnly = { OPENCODEX_ADMIN_AUTH_TOKEN: "management-only" };
    const admission = droidAdmissionEnvironment(config, adminOnly);
    expect(admission.apiKeyRef).toBeUndefined();
    expect(admission.env.OCX_ADMISSION_TOKEN).toBeUndefined();
    expect(admission.env.OPENCODEX_ADMIN_AUTH_TOKEN).toBeUndefined();
    expect(admission.env).toEqual({});
    expect(adminOnly).toEqual({
      OPENCODEX_ADMIN_AUTH_TOKEN: "management-only",
    });
  });

  test("retains ordinary launch environment without exporting management auth", () => {
    const original = {
      OPENCODEX_ADMIN_AUTH_TOKEN: "admin-must-stay-private",
      PATH: "/fixture/bin",
      HOME: "/fixture/home",
    };
    const snapshot = { ...original };
    const admission = droidAdmissionEnvironment(config, original);
    expect(admission.env).toEqual({
      PATH: "/fixture/bin",
      HOME: "/fixture/home",
    });
    expect(original).toEqual(snapshot);
  });

  test("accepts a configured data-plane API key without mutating config or parent env", () => {
    const withApiKeys = {
      ...config,
      apiKeys: [{ key: "configured-data-plane-fixture" }],
    } as OcxConfig;
    const original = { OPENCODEX_ADMIN_AUTH_TOKEN: "management-only" };
    const admission = droidAdmissionEnvironment(withApiKeys, original);
    expect(admission.env.OCX_ADMISSION_TOKEN).toBe(
      "configured-data-plane-fixture",
    );
    expect(admission.apiKeyRef).toBe("${OCX_ADMISSION_TOKEN}");
    expect(original).not.toHaveProperty("OCX_ADMISSION_TOKEN");
  });
});

describe("ocx droid Codex Direct credential boundary", () => {
  const routed = [
    { provider: "openai", id: "openai/gpt-6-astra" },
    { provider: "zai", id: "zai/glm-5.3-flash" },
    { provider: "openai-apikey", id: "openai-apikey/gpt-6-api" },
  ];

  const openaiDirectConfig = {
    ...config,
    providers: {
      ...config.providers,
      openai: {
        ...config.providers.openai,
        codexAccountMode: "direct",
      },
    },
  } as OcxConfig;

  test("hides only Direct OpenAI routes instead of forwarding OCX admission as caller OAuth", () => {
    const before = structuredClone(routed);
    expect(droidByokCompatibleModels(openaiDirectConfig, routed)).toEqual([
      routed[1],
      routed[2],
    ]);
    expect(routed).toEqual(before);
  });

  test("does not offer a Direct-only catalog to Factory BYOK", () => {
    expect(
      droidByokCompatibleModels(openaiDirectConfig, [routed[0]!]),
    ).toEqual([]);
  });

  test("retains OpenAI pool routes and other providers", () => {
    const pool = {
      ...openaiDirectConfig,
      providers: {
        ...openaiDirectConfig.providers,
        openai: {
          ...openaiDirectConfig.providers.openai,
          codexAccountMode: "pool",
        },
      },
    } as OcxConfig;
    expect(droidByokCompatibleModels(pool, routed)).toEqual(routed);
  });

  test("excludes any combo that can fail over or rotate to Codex Direct", () => {
    const mixed = {
      ...openaiDirectConfig,
      combos: {
        fallback: {
          strategy: "failover",
          targets: [
            { provider: "zai", model: "glm-5.3-flash" },
            { provider: "openai", model: "gpt-6-astra" },
          ],
        },
        balanced: {
          strategy: "round-robin",
          targets: [
            { provider: "openai", model: "gpt-6-astra", weight: 1 },
            { provider: "zai", model: "glm-5.3-flash", weight: 2 },
          ],
        },
        safe: {
          strategy: "round-robin",
          targets: [
            { provider: "zai", model: "glm-5.3-flash" },
            { provider: "openai-apikey", model: "gpt-api" },
          ],
        },
      },
    } as OcxConfig;
    const rows = [
      ...routed,
      { provider: "combo", id: "combo/fallback" },
      { provider: "combo", id: "combo/balanced" },
      { provider: "combo", id: "combo/safe" },
    ];
    const before = structuredClone(rows);
    expect(droidByokCompatibleModels(mixed, rows)).toEqual([
      routed[1],
      routed[2],
      rows[5],
    ]);
    expect(rows).toEqual(before);
  });

  test("rejects a Direct-target combo reached by a public alias", () => {
    const aliased = {
      ...openaiDirectConfig,
      combos: {
        hybrid: {
          alias: "fallback/assistant",
          targets: [
            { provider: "zai", model: "glm-5.3-flash" },
            { provider: "openai", model: "gpt-6-astra" },
          ],
        },
      },
    } as OcxConfig;
    expect(
      droidByokCompatibleModels(aliased, [
        { provider: "combo", id: "fallback/assistant" },
        { provider: "zai", id: "zai/glm-5.3-flash" },
      ]),
    ).toEqual([{ provider: "zai", id: "zai/glm-5.3-flash" }]);
  });

  test("fails closed on an unknown dynamic combo without removing ordinary providers", () => {
    expect(
      droidByokCompatibleModels(openaiDirectConfig, [
        { provider: "combo", id: "combo/stale" },
        routed[1]!,
      ]),
    ).toEqual([routed[1]]);
  });

  test("keeps a physical provider named combo when no dynamic combos are configured", () => {
    const physical = {
      ...openaiDirectConfig,
      providers: {
        ...openaiDirectConfig.providers,
        combo: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:9999/v1" },
      },
      combos: {},
    } as OcxConfig;
    const physicalRow = { provider: "combo", id: "combo/model" };
    expect(droidByokCompatibleModels(physical, [physicalRow])).toEqual([
      physicalRow,
    ]);
  });

  test("does not classify an explicitly disabled Codex pool subsystem as Direct", () => {
    const standalone = {
      ...openaiDirectConfig,
      codexAccountPools: false,
    } as OcxConfig;
    expect(droidByokCompatibleModels(standalone, routed)).toEqual(routed);
  });
});
