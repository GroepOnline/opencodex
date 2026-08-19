import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyAttempt,
  clearKeyPoolCooldowns,
  hopChainTargets,
  isAccountPoolHopStatus,
  resolveAnthropicPoolOutcome,
  resolveGoogleAntigravityPoolOutcome,
  resolveOutcome,
  selectCodexCandidate,
  selectHopChain,
  selectOauthPoolCandidate,
} from "../src/availability";
import {
  clearAnthropicAccountPoolState,
  rotateAnthropicAccountOn429,
} from "../src/oauth/anthropic-routing";
import { getAccountSet, saveCredential, setActiveAccount } from "../src/oauth/store";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

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

describe("resolveOutcome", () => {
  let home: string;

  const pool = [
    { id: "k1", key: "key-alpha-000111222333", addedAt: 1 },
    { id: "k2", key: "key-beta-444555666777", addedAt: 2 },
  ];

  function poolConfig(): OcxConfig {
    return {
      port: 10100,
      defaultProvider: "p",
      providers: {
        p: {
          adapter: "openai-chat",
          baseUrl: "https://p.example/v1",
          apiKey: pool[0]!.key,
          apiKeyPool: pool,
        } as OcxProviderConfig,
      },
    };
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-availability-"));
    process.env.OPENCODEX_HOME = home;
    clearKeyPoolCooldowns();
  });

  afterEach(() => {
    delete process.env.OPENCODEX_HOME;
    rmSync(home, { recursive: true, force: true });
    clearKeyPoolCooldowns();
  });

  test("surfaces 503 and single-key providers", () => {
    const config = poolConfig();
    expect(resolveOutcome({
      config,
      providerName: "p",
      routedProvider: config.providers.p!,
      status: 503,
    })).toBeNull();
    const single = poolConfig();
    delete single.providers.p!.apiKeyPool;
    expect(resolveOutcome({
      config: single,
      providerName: "p",
      routedProvider: single.providers.p!,
      status: 429,
    })).toBeNull();
  });

  test("hops 429 to the next key and records cooldown", () => {
    const config = poolConfig();
    const next = resolveOutcome({
      config,
      providerName: "p",
      routedProvider: config.providers.p!,
      status: 429,
      now: 1_000_000,
      attemptedKey: pool[0]!.key,
    });
    expect(next?.apiKey).toBe(pool[1]!.key);
    expect(config.providers.p!.apiKey).toBe(pool[1]!.key);
  });

  test("hops 529 the same way as 429", () => {
    const config = poolConfig();
    const next = resolveOutcome({
      config,
      providerName: "p",
      routedProvider: config.providers.p!,
      status: 529,
      now: 1_000_000,
      attemptedKey: pool[0]!.key,
    });
    expect(next?.apiKey).toBe(pool[1]!.key);
  });
});

describe("oauth pool resolveOutcome", () => {
  test("surfaces statuses that are not 429/529 without touching accounts", async () => {
    const config = baseConfig();
    const routed = config.providers.a!;
    expect(await resolveAnthropicPoolOutcome({
      config,
      status: 400,
      failedAccountId: "acct-1",
      routedProvider: routed,
    })).toBeNull();
    expect(await resolveGoogleAntigravityPoolOutcome({
      config,
      status: 503,
      failedAccountId: "acct-1",
      routedProvider: routed,
    })).toBeNull();
  });
});

describe("selectOauthPoolCandidate", () => {
  let home: string;
  const previousHome = process.env.OPENCODEX_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-availability-select-"));
    process.env.OPENCODEX_HOME = home;
    clearAnthropicAccountPoolState();
  });

  afterEach(() => {
    clearAnthropicAccountPoolState();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  const routed: OcxProviderConfig = {
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com",
    authMode: "oauth",
  };

  async function seedAnthropicPair() {
    await saveCredential("anthropic", {
      access: "access-a",
      refresh: "refresh-a",
      expires: Date.now() + 3_600_000,
      accountId: "uuid-aaaa",
      email: "a@example.test",
    });
    await saveCredential("anthropic", {
      access: "access-b",
      refresh: "refresh-b",
      expires: Date.now() + 3_600_000,
      accountId: "uuid-bbbb",
      email: "b@example.test",
    });
    const set = getAccountSet("anthropic")!;
    const a = set.accounts.find(acc => acc.credential.accountId === "uuid-aaaa")!;
    await setActiveAccount("anthropic", a.id);
    return { aId: a.id };
  }

  function poolConfig(enabled: boolean): OcxConfig {
    return baseConfig({
      defaultProvider: "anthropic",
      providers: { anthropic: routed },
      anthropicAccountPool: { enabled },
    });
  }

  test("returns not-pooled when the Anthropic pool is off", async () => {
    await seedAnthropicPair();
    const result = await selectOauthPoolCandidate({
      providerName: "anthropic",
      config: poolConfig(false),
      routedProvider: routed,
      sessionKey: "sess-1",
    });
    expect(result).toEqual({ kind: "not-pooled" });
  });

  test("returns a fetch-ready Anthropic candidate", async () => {
    const { aId } = await seedAnthropicPair();
    const result = await selectOauthPoolCandidate({
      providerName: "anthropic",
      config: poolConfig(true),
      routedProvider: routed,
      sessionKey: "sess-1",
    });
    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") return;
    expect(result.pool).toBe("anthropic");
    expect(result.hop.accountId).toBe(aId);
    expect(result.hop.provider.apiKey).toBe("access-a");
  });

  test("returns all-cooled when every Anthropic account is cooling", async () => {
    const { aId } = await seedAnthropicPair();
    const config = poolConfig(true);
    const bId = getAccountSet("anthropic")!.accounts.find(acc => acc.id !== aId)!.id;
    expect(rotateAnthropicAccountOn429(config, aId, "120")).toBe(bId);
    expect(rotateAnthropicAccountOn429(config, bId, "120")).toBeNull();
    const result = await selectOauthPoolCandidate({
      providerName: "anthropic",
      config,
      routedProvider: routed,
      sessionKey: "cooled",
    });
    expect(result.kind).toBe("all-cooled");
    if (result.kind !== "all-cooled") return;
    expect(result.pool).toBe("anthropic");
    expect(result.retryAfterSeconds).not.toBeNull();
  });
});

describe("selectCodexCandidate", () => {
  test("without a Codex account mode forwards the caller bearer", async () => {
    const config = baseConfig();
    const result = await selectCodexCandidate({
      headers: new Headers({ authorization: "Bearer client-token" }),
      config,
      modelId: "gpt-5",
      routedProvider: config.providers.a!,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.authCtx).toEqual({ kind: "main", accountId: null });
    expect(result.headers.get("authorization")).toBe("Bearer client-token");
    expect(result.provider).toEqual(config.providers.a!);
  });

  test("Direct without a caller bearer is a domain failure", async () => {
    const config = baseConfig();
    const result = await selectCodexCandidate({
      headers: new Headers(),
      config,
      mode: "direct",
      modelId: "gpt-5",
      routedProvider: config.providers.a!,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("direct-auth");
  });
});
