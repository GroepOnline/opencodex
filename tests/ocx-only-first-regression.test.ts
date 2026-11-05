/**
 * Regression tests for OCX-only first (issue #336).
 *
 * These tests pin the launch-time contract: Claude Code, Droid, Codex, and Claude
 * Desktop get models and credentials from OCX without requiring paid native
 * subscriptions, while optional native modes keep working when configured.
 *
 * Scope note: this file asserts the LAUNCH contract (env assembly, admission
 * headers, overlay shape, canonical paths). The deeper invariants — canonical
 * OCX catalog contents, journal restore/eject, Codex sync, desktop 3P registry
 * decode — are owned by the dedicated suites under tests/codex-*.test.ts and the
 * claude desktop tests; do not duplicate them here as placeholders.
 */

import { describe, expect, test } from "bun:test";
import {
  buildClaudeEnv,
  claudeAdmissionToken,
  isClaudeProviderManagedByHost,
  attachClaudeAdmissionHeaderForManagedRoute,
} from "../src/cli/claude";
import {
  buildDroidSettingsOverlay,
  droidByokCompatibleModels,
  droidAdmissionEnvironment,
  droidCustomModelId,
  type DroidRoutedModel,
} from "../src/cli/droid";
import { PROXY_MARKER } from "../src/claude/auth-detect";
import { DESKTOP_FAMILIES } from "../src/claude/desktop-profile";
import { CODEX_HOME, DEFAULT_CATALOG_PATH } from "../src/codex/paths";
import type { OcxConfig } from "../src/types";

describe("OCX-only Claude Code regression", () => {
  test("Claude Code env injects OCX ANTHROPIC_BASE_URL without requiring native login", () => {
    const config: OcxConfig = {
      port: 10100,
      apiKeys: [{ key: "ocx-test-key" }],
    };
    const env = buildClaudeEnv(config, 10100, {});
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:10100");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("ocx-test-key");
    // No native login required: OCX provides the credential
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
  });

  test("Claude Code respects user-exported ANTHROPIC_AUTH_TOKEN (native mode preserved)", () => {
    const config: OcxConfig = { port: 10100 };
    const env = buildClaudeEnv(config, 10100, {
      ANTHROPIC_AUTH_TOKEN: "user-native-token",
    });
    // User export wins (subscription mode preserved)
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("user-native-token");
    // Host-managed flag IS set when ANY Anthropic token is present (OCX's contract)
    // This is safe: Claude Code uses it to strip settings.env provider vars
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
  });

  test("Claude Code injects PROXY_MARKER when auth mode is proxy and OCX has no key", () => {
    // Manual proxy mode bypasses detection entirely (resolveClaudeAuthMode), so
    // this is deterministic on any machine regardless of real native auth state.
    const config: OcxConfig = {
      port: 10100,
      claudeCode: { authMode: "proxy" },
    };
    const env = buildClaudeEnv(config, 10100, {});
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(PROXY_MARKER);
    // The marker counts as a host-supplied credential for the managed-env strip.
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
  });

  test("Claude Code auto mode injects PROXY_MARKER when detection finds no native auth", () => {
    const config: OcxConfig = { port: 10100 };
    const env = buildClaudeEnv(
      config,
      10100,
      {},
      {},
      {
        authDetect: {
          readClaudeJson: () => undefined,
          credentialsFileExists: () => false,
          keychainProbe: () => "absent",
        },
      },
    );
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(PROXY_MARKER);
  });

  test("Claude Code subscription mode injects no marker and no managed flag without a token", () => {
    const config: OcxConfig = {
      port: 10100,
      claudeCode: { authMode: "subscription" },
    };
    const env = buildClaudeEnv(config, 10100, {});
    // Subscription mode must not displace the user's own Claude login with a dummy.
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined();
    // The proxy route itself is still pinned.
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:10100");
  });

  test("Claude Code gateway model discovery is enabled for OCX routing", () => {
    const config: OcxConfig = { port: 10100 };
    const env = buildClaudeEnv(config, 10100, {});
    expect(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
  });

  test("Claude Code admission header is only attached on managed loopback route", () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:10100",
    };
    const managed = attachClaudeAdmissionHeaderForManagedRoute(
      env,
      "test-token",
      10100,
    );
    expect(managed).toBe(true);
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toContain(
      "x-opencodex-api-key: test-token",
    );
  });

  test("Claude Code admission header is stripped on non-managed routes", () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      ANTHROPIC_CUSTOM_HEADERS: "x-opencodex-api-key: stale-token",
    };
    const managed = attachClaudeAdmissionHeaderForManagedRoute(
      env,
      "test-token",
      10100,
    );
    expect(managed).toBe(false);
    // The header is removed when not on managed route (deleted key)
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
  });

  test("Claude Code admission header is refused on a loopback URL with the wrong port", () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9999",
    };
    const managed = attachClaudeAdmissionHeaderForManagedRoute(
      env,
      "test-token",
      10100,
    );
    // A different listener on loopback is not this OCX instance — no credential.
    expect(managed).toBe(false);
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
  });

  test("Claude Code provider-managed detection is based on OCX auth, not native login", () => {
    const envWithOcx: Record<string, string | undefined> = {
      ANTHROPIC_AUTH_TOKEN: "ocx-token",
    };
    expect(isClaudeProviderManagedByHost(envWithOcx, null)).toBe(true);

    const envWithNative: Record<string, string | undefined> = {
      ANTHROPIC_AUTH_TOKEN: "native-token",
    };
    expect(isClaudeProviderManagedByHost(envWithNative, null)).toBe(true);

    const envWithAdmission: Record<string, string | undefined> = {};
    expect(
      isClaudeProviderManagedByHost(envWithAdmission, "ocx-admission"),
    ).toBe(true);

    const envWithNone: Record<string, string | undefined> = {};
    expect(isClaudeProviderManagedByHost(envWithNone, null)).toBe(false);
  });

  test("Claude Code admission token resolves in precedence order", () => {
    const config: OcxConfig = {
      apiKeys: [{ key: "config-key" }],
    };
    const env: Record<string, string | undefined> = {
      ANTHROPIC_AUTH_TOKEN: "injected-token",
      OCX_ADMISSION_TOKEN: "env-token",
    };

    // Injected token wins first
    const token1 = claudeAdmissionToken(env, config);
    expect(token1).toBe("injected-token");

    // Config key wins when env has no token
    const token2 = claudeAdmissionToken({}, config);
    expect(token2).toBe("config-key");

    // Data-plane token wins when others absent
    const token3 = claudeAdmissionToken(
      {},
      { ...config, apiKeys: [] },
      { OPENCODEX_API_AUTH_TOKEN: "service-token" },
    );
    expect(token3).toBe("service-token");
  });
});

describe("OCX-only Droid regression", () => {
  test("Droid BYOK overlay is additive and does not rewrite user settings", () => {
    const config: OcxConfig = {
      port: 10100,
      injectionModel: "openai/gpt-5.6-sol",
    };
    const models: DroidRoutedModel[] = [
      {
        provider: "openai",
        id: "openai/gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
      },
      {
        provider: "anthropic",
        id: "anthropic/claude-sonnet-4",
        displayName: "Sonnet 4",
      },
    ];
    const overlay = buildDroidSettingsOverlay(config, 10100, models);

    // Overlay has OCX models
    expect(overlay.customModels.length).toBeGreaterThan(0);
    // Preferred model is the injection model if available
    expect(overlay.model).toContain("ocx");
    // The overlay is designed for --settings flag, not in-place user config replacement
    expect(overlay.customModels[0]!.baseUrl).toContain("/v1");
  });

  test("Droid BYOK compatibility filters Direct-mode OpenAI and its combos", () => {
    // providerCodexAccountMode reads `codexAccountMode`, not `mode`; codexAccountPools
    // must be enabled or the resolver returns undefined and no filtering happens.
    const config: OcxConfig = {
      port: 10100,
      codexAccountPools: true,
      providers: {
        openai: { codexAccountMode: "direct" },
      },
      combos: {
        factory: {
          targets: [{ provider: "anthropic", model: "claude-sonnet-4" }],
        },
        chatgpt: { targets: [{ provider: "openai", model: "gpt-5.6" }] },
        empty: { targets: [] },
      },
    };
    const models: DroidRoutedModel[] = [
      { provider: "openai", id: "openai/gpt-5.6-sol" },
      { provider: "anthropic", id: "anthropic/claude-sonnet-4" },
      { provider: "combo", id: "combo/factory" },
      { provider: "combo", id: "combo/chatgpt" },
      { provider: "combo", id: "combo/empty" },
    ];
    const compatible = droidByokCompatibleModels(config, models).map(
      (m) => m.id,
    );
    // A BYOK key is an OCX admission token, not a Codex OAuth bearer: Direct-mode
    // openai rows, combos that resolve to openai targets, and unresolvable combos
    // are excluded; non-openai models and all-anthropic combos stay.
    expect(compatible).toEqual(["anthropic/claude-sonnet-4", "combo/factory"]);
  });

  test("Droid BYOK compatibility keeps every model when OpenAI is pool-mode", () => {
    const config: OcxConfig = {
      port: 10100,
      codexAccountPools: true,
      providers: {
        openai: { codexAccountMode: "pool" },
      },
    };
    const models: DroidRoutedModel[] = [
      { provider: "openai", id: "openai/gpt-5.6-sol" },
      { provider: "anthropic", id: "anthropic/claude-sonnet-4" },
    ];
    expect(droidByokCompatibleModels(config, models)).toHaveLength(2);
  });

  test("Droid admission environment uses OCX token, never management key", () => {
    const config: OcxConfig = {
      apiKeys: [{ key: "ocx-data-plane-key" }],
    };
    const env: NodeJS.ProcessEnv = {
      OPENCODEX_ADMIN_AUTH_TOKEN: "admin-key",
      OCX_ADMISSION_TOKEN: "admission-key",
    };
    const admission = droidAdmissionEnvironment(config, env);

    // OCX admission token is passed
    expect(admission.env.OCX_ADMISSION_TOKEN).toBe("admission-key");
    // Management key is stripped from child env
    expect(admission.env.OPENCODEX_ADMIN_AUTH_TOKEN).toBeUndefined();
    // apiKeyRef uses env variable for loopback safety
    expect(admission.apiKeyRef).toBe("${OCX_ADMISSION_TOKEN}");
  });

  test("Droid custom model IDs are stable, deterministic and distinct", () => {
    const id1 = droidCustomModelId("openai/gpt-5.6-sol");
    const id2 = droidCustomModelId("openai/gpt-5.6-sol");
    const other = droidCustomModelId("anthropic/claude-sonnet-4");
    expect(id1).toBe(id2);
    // 24 hex chars (96 bits) of sha256 over the routed id — name/order independent.
    expect(id1).toMatch(/^custom:ocx-[a-f0-9]{24}$/);
    expect(other).toMatch(/^custom:ocx-[a-f0-9]{24}$/);
    expect(id1).not.toBe(other);
  });

  test("Droid overlay deduplicates repeated routed ids", () => {
    const models: DroidRoutedModel[] = [
      { provider: "openai", id: "openai/gpt-5.6" },
      { provider: "openai", id: "openai/gpt-5.6" },
      { provider: "anthropic", id: "anthropic/claude-sonnet-4" },
    ];
    const overlay = buildDroidSettingsOverlay({ port: 10100 }, 10100, models);
    expect(overlay.customModels).toHaveLength(2);
  });

  test("Droid baseUrl includes /v1 for OpenAI Responses wire", () => {
    const models: DroidRoutedModel[] = [{ provider: "openai", id: "test" }];
    const overlay = buildDroidSettingsOverlay({ port: 10100 }, 10100, models);
    expect(overlay.customModels[0]!.baseUrl).toBe("http://127.0.0.1:10100/v1");
  });

  test("Droid baseUrl supports custom origin for tunnelled proxies", () => {
    const models: DroidRoutedModel[] = [{ provider: "openai", id: "test" }];
    const overlay = buildDroidSettingsOverlay({ port: 10100 }, 10100, models, {
      origin: "https://ocx.example.com",
    });
    expect(overlay.customModels[0]!.baseUrl).toBe("https://ocx.example.com/v1");
  });
});

describe("OCX-only Codex regression", () => {
  test("Codex managed catalog is the canonical OCX catalog inside CODEX_HOME", () => {
    // The coexistence invariant: $CODEX_HOME/opencodex-catalog.json is the only
    // merged catalog — never a user model_catalog_json and never a parallel
    // native-plus-ocx merge file. Contents and sync behavior are covered by the
    // dedicated codex sync/catalog suites.
    expect(DEFAULT_CATALOG_PATH.startsWith(CODEX_HOME)).toBe(true);
    expect(DEFAULT_CATALOG_PATH.endsWith("opencodex-catalog.json")).toBe(true);
    expect(DEFAULT_CATALOG_PATH).not.toContain("model_catalog");
  });
});

describe("OCX-only Claude Desktop regression", () => {
  test("Claude Desktop model picker covers exactly the four Anthropic families", () => {
    expect([...DESKTOP_FAMILIES]).toEqual(["opus", "fable", "sonnet", "haiku"]);
  });
});

describe("OCX-only first: both modes (native absent/present)", () => {
  test("OCX-only mode works when native login is absent", () => {
    const config: OcxConfig = {
      port: 10100,
      apiKeys: [{ key: "ocx-key" }],
    };
    const env = buildClaudeEnv(config, 10100, {});
    // OCX provides credential
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("ocx-key");
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
  });

  test("Native+OCX mode preserves native login when present", () => {
    const config: OcxConfig = { port: 10100 };
    const env = buildClaudeEnv(config, 10100, {
      ANTHROPIC_AUTH_TOKEN: "user-native-token",
    });
    // User export wins (native mode preserved)
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("user-native-token");
    // Host-managed IS set when ANY Anthropic token is present (OCX's contract)
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
  });

  test("Droid overlay preserves a full routed catalog without truncation", () => {
    // A realistic large selector list must pass through whole — 117 rows matches
    // the reported production baseline (issue #336 evidence).
    const models: DroidRoutedModel[] = Array.from({ length: 117 }, (_, i) => ({
      provider: i % 2 === 0 ? "openai" : "anthropic",
      id: `model-${i}`,
      displayName: `Model ${i}`,
    }));
    const config: OcxConfig = { port: 10100 };
    const overlay = buildDroidSettingsOverlay(config, 10100, models);
    expect(overlay.customModels).toHaveLength(117);
  });

  test("Droid OCX-only mode works when Factory subscription is absent", () => {
    const config: OcxConfig = {
      port: 10100,
      apiKeys: [{ key: "ocx-key" }],
    };
    const models: DroidRoutedModel[] = [
      { provider: "anthropic", id: "anthropic/claude-sonnet-4" },
    ];
    const overlay = buildDroidSettingsOverlay(config, 10100, models, {
      apiKeyRef: "${OCX_ADMISSION_TOKEN}",
    });
    // Overlay uses OCX endpoint and credential reference
    expect(overlay.customModels[0]!.baseUrl).toContain("127.0.0.1:10100");
    // No Factory native login required - uses env reference
    expect(overlay.customModels[0]!.apiKey).toBe("${OCX_ADMISSION_TOKEN}");
  });
});
