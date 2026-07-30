import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  filterClientCatalogModels,
  hideUnavailableModelsEnabled,
  providerClientHideReason,
  shouldHideProviderFromClients,
} from "../src/codex/catalog-visibility";
import {
  clearModelCache,
  getDiscoveryFailStreak,
  getStaleCached,
  isModelsFetchCoolingDown,
  markModelsFetchFailure,
  markProviderDiscoveryOk,
  MODELS_FETCH_FAILURE_COOLDOWN_MS,
  setCached,
} from "../src/codex/model-cache";
import { gatherRoutedModels } from "../src/codex/catalog";
import { markAccountNeedsReauth, saveCredential } from "../src/oauth/store";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import { withStubbedProviderFetch } from "./helpers/catalog-provider-fetch";

const PROVIDER = "heal-demo";

function baseConfig(over: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: PROVIDER,
    providers: {
      [PROVIDER]: {
        adapter: "openai-chat",
        authMode: "key",
        apiKey: "sk-test",
        baseUrl: "https://93.184.216.34/v1",
        models: ["alpha", "beta"],
      } satisfies OcxProviderConfig,
    },
    ...over,
  } as OcxConfig;
}

describe("discovery exponential backoff", () => {
  afterEach(() => clearModelCache());

  test("failures escalate delay and reset on first success", () => {
    const t0 = 1_000_000;
    markModelsFetchFailure(PROVIDER, t0);
    expect(getDiscoveryFailStreak(PROVIDER)).toBe(1);
    expect(isModelsFetchCoolingDown(PROVIDER, MODELS_FETCH_FAILURE_COOLDOWN_MS, t0 + 1)).toBe(true);
    expect(isModelsFetchCoolingDown(PROVIDER, MODELS_FETCH_FAILURE_COOLDOWN_MS, t0 + MODELS_FETCH_FAILURE_COOLDOWN_MS)).toBe(false);

    markModelsFetchFailure(PROVIDER, t0 + MODELS_FETCH_FAILURE_COOLDOWN_MS);
    expect(getDiscoveryFailStreak(PROVIDER)).toBe(2);
    // Second failure doubles the wait (60s).
    expect(isModelsFetchCoolingDown(
      PROVIDER,
      MODELS_FETCH_FAILURE_COOLDOWN_MS,
      t0 + MODELS_FETCH_FAILURE_COOLDOWN_MS + MODELS_FETCH_FAILURE_COOLDOWN_MS,
    )).toBe(true);
    expect(isModelsFetchCoolingDown(
      PROVIDER,
      MODELS_FETCH_FAILURE_COOLDOWN_MS,
      t0 + MODELS_FETCH_FAILURE_COOLDOWN_MS + 2 * MODELS_FETCH_FAILURE_COOLDOWN_MS,
    )).toBe(false);

    markProviderDiscoveryOk(PROVIDER, 2);
    expect(getDiscoveryFailStreak(PROVIDER)).toBe(0);
    expect(isModelsFetchCoolingDown(PROVIDER, MODELS_FETCH_FAILURE_COOLDOWN_MS, t0 + 10_000_000)).toBe(false);
  });
});

describe("catalog heal + hideUnavailableModels", () => {
  const originalFetch = globalThis.fetch;
  let previousHome: string | undefined;
  let testDir: string;

  beforeEach(() => {
    clearModelCache();
    previousHome = process.env.OPENCODEX_HOME;
    testDir = join(tmpdir(), `ocx-catalog-heal-${crypto.randomUUID()}`);
    mkdirSync(testDir, { recursive: true, mode: 0o700 });
    process.env.OPENCODEX_HOME = testDir;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearModelCache();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    rmSync(testDir, { recursive: true, force: true });
  });

  test("transient discovery fail keeps last-good in gather and client list during grace", async () => {
    setCached(PROVIDER, [
      { provider: PROVIDER, id: "alpha" },
      { provider: PROVIDER, id: "beta" },
    ]);
    globalThis.fetch = (async () => {
      throw new Error("transient");
    }) as typeof fetch;

    const config = withStubbedProviderFetch(baseConfig({
      modelCacheTtlMs: 0,
      hideUnavailableModels: true,
      hideUnavailableAfterDiscoveryFails: 3,
    }));
    const models = await gatherRoutedModels(config);
    expect(models.map(m => m.id).sort()).toEqual(["alpha", "beta"]);
    expect(getStaleCached(PROVIDER)?.map(m => m.id).sort()).toEqual(["alpha", "beta"]);
    expect(getDiscoveryFailStreak(PROVIDER)).toBe(1);
    expect(providerClientHideReason(PROVIDER, config)).toBeNull();
    expect(filterClientCatalogModels(models, config).map(m => m.id).sort()).toEqual(["alpha", "beta"]);
  });

  test("grace exceeded hides from clients but admin reason stays visible; last-good retained", () => {
    const lastGood = [{ provider: PROVIDER, id: "alpha" }];
    setCached(PROVIDER, lastGood);
    const config = baseConfig({
      hideUnavailableModels: true,
      hideUnavailableAfterDiscoveryFails: 2,
    });

    markModelsFetchFailure(PROVIDER);
    expect(providerClientHideReason(PROVIDER, config)).toBeNull();
    expect(filterClientCatalogModels(lastGood, config)).toEqual(lastGood);

    markModelsFetchFailure(PROVIDER);
    expect(getDiscoveryFailStreak(PROVIDER)).toBe(2);
    expect(providerClientHideReason(PROVIDER, config)).toBe("discovery_failed");
    expect(shouldHideProviderFromClients(PROVIDER, config)).toBe(true);
    expect(filterClientCatalogModels(lastGood, config)).toEqual([]);
    // Admin path: last-good catalog remains for Models tab / routing.
    expect(getStaleCached(PROVIDER)).toEqual(lastGood);
  });

  test("hideUnavailableModels default false never filters clients after repeated fails", () => {
    const config = baseConfig();
    expect(hideUnavailableModelsEnabled(config)).toBe(false);
    markModelsFetchFailure(PROVIDER);
    markModelsFetchFailure(PROVIDER);
    markModelsFetchFailure(PROVIDER);
    expect(providerClientHideReason(PROVIDER, config)).toBe("discovery_failed");
    expect(shouldHideProviderFromClients(PROVIDER, config)).toBe(false);
    const rows = [{ provider: PROVIDER, id: "alpha" }];
    expect(filterClientCatalogModels(rows, config)).toEqual(rows);
  });

  test("recovery clears streak and restores client visibility immediately", async () => {
    const config = baseConfig({
      hideUnavailableModels: true,
      hideUnavailableAfterDiscoveryFails: 2,
    });
    markModelsFetchFailure(PROVIDER);
    markModelsFetchFailure(PROVIDER);
    expect(shouldHideProviderFromClients(PROVIDER, config)).toBe(true);

    markProviderDiscoveryOk(PROVIDER, 1);
    expect(getDiscoveryFailStreak(PROVIDER)).toBe(0);
    expect(providerClientHideReason(PROVIDER, config)).toBeNull();
    expect(shouldHideProviderFromClients(PROVIDER, config)).toBe(false);
    expect(filterClientCatalogModels([{ provider: PROVIDER, id: "alpha" }], config)).toEqual([
      { provider: PROVIDER, id: "alpha" },
    ]);
  });

  test("active session still resolves last-good after client hide", async () => {
    setCached(PROVIDER, [{ provider: PROVIDER, id: "alpha" }]);
    markModelsFetchFailure(PROVIDER);
    markModelsFetchFailure(PROVIDER);
    markModelsFetchFailure(PROVIDER);
    const config = withStubbedProviderFetch(baseConfig({
      modelCacheTtlMs: 0,
      hideUnavailableModels: true,
      hideUnavailableAfterDiscoveryFails: 3,
    }));
    // Cooling down: gather serves last-good without a live probe.
    globalThis.fetch = (() => {
      throw new Error("must not fetch while cooling");
    }) as typeof fetch;
    const gathered = await gatherRoutedModels(config);
    expect(gathered.map(m => `${m.provider}/${m.id}`)).toContain(`${PROVIDER}/alpha`);
    expect(filterClientCatalogModels(gathered, config).map(m => m.id)).not.toContain("alpha");
  });

  test("single-account reauth does not hide; all accounts reauth does", async () => {
    const oauthProvider = "oauth-heal";
    await saveCredential(oauthProvider, {
      access: "a1",
      refresh: "r1",
      expires: Date.now() + 3600_000,
      accountId: "acct-1",
      email: "one@example.com",
    });
    await saveCredential(oauthProvider, {
      access: "a2",
      refresh: "r2",
      expires: Date.now() + 3600_000,
      accountId: "acct-2",
      email: "two@example.com",
    });
    const set = (await import("../src/oauth/store")).getAccountSet(oauthProvider)!;
    const first = set.accounts[0]!.id;
    const second = set.accounts[1]!.id;
    await markAccountNeedsReauth(oauthProvider, first, true);

    const config = {
      port: 10100,
      defaultProvider: oauthProvider,
      hideUnavailableModels: true,
      providers: {
        [oauthProvider]: {
          adapter: "openai-chat",
          authMode: "oauth",
          baseUrl: "https://93.184.216.34/v1",
          models: ["m1"],
        },
      },
    } as OcxConfig;

    expect(providerClientHideReason(oauthProvider, config)).toBeNull();
    expect(shouldHideProviderFromClients(oauthProvider, config)).toBe(false);

    await markAccountNeedsReauth(oauthProvider, second, true);
    expect(providerClientHideReason(oauthProvider, config)).toBe("all_accounts_reauth");
    expect(shouldHideProviderFromClients(oauthProvider, config)).toBe(true);
  });
});
