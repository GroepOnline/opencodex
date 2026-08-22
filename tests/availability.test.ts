import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configModule from "../src/config";
import {
  canHopNativeClaudePierce,
  classifyAttempt,
  clearKeyPoolCooldowns,
  isAccountPoolHopStatus,
  isOauthAccountPoolHopStatus,
  inspectAvailability,
  inspectKeyPool,
  recordCapOutcome,
  resolveAnthropicPoolOutcome,
  resolveGoogleAntigravityPoolOutcome,
  resolveOutcome,
  selectCandidate,
  selectCodexCandidate,
  selectHopChain,
  selectKeyPoolCandidate,
  selectOauthPoolCandidate,
} from "../src/availability";
import { getCombo } from "../src/combos/types";
import { handleResponses } from "../src/server/responses";
import { selectCandidateFailResponse } from "../src/server/responses/select-http";
import {
  clearAnthropicAccountPoolState,
  rotateAnthropicAccountOn429,
} from "../src/oauth/anthropic-routing";
import { getAccountSet, saveCredential, setActiveAccount } from "../src/oauth/store";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

function restoreOpenCodexHome(previous: string | undefined): void {
  if (previous === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previous;
}

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
    expect(isAccountPoolHopStatus(402)).toBe(false);
  });

  test("OAuth pools additionally hop account-scoped 402 caps", () => {
    expect(isOauthAccountPoolHopStatus(429)).toBe(true);
    expect(isOauthAccountPoolHopStatus(529)).toBe(true);
    expect(isOauthAccountPoolHopStatus(402)).toBe(true);
    expect(isOauthAccountPoolHopStatus(503)).toBe(false);
  });
});

describe("selectHopChain", () => {
  test("returns the routed target first, then fallback providers", () => {
    const config = baseConfig();
    config.providers.a!.fallback = [{ provider: "b", model: "m2" }, { provider: "c", model: "m3" }];
    const chain = selectHopChain(config, { provider: "a", modelId: "m1" });
    expect(chain).not.toBeNull();
    expect(chain!.preservePhysicalIdentity).toBe(true);
    expect(getCombo(chain!.config, chain!.comboId)!.targets.map(({ provider, model }) => ({ provider, model }))).toEqual([
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

describe("canHopNativeClaudePierce", () => {
  function anthropicFallbackConfig(): OcxConfig {
    return baseConfig({
      providers: {
        ...baseConfig().providers,
        anthropic: {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          authMode: "oauth",
          fallback: [{ provider: "a", model: "m1" }],
        },
      },
    });
  }

  test("is false without an Anthropic pool or fallback list", () => {
    expect(canHopNativeClaudePierce(baseConfig())).toBe(false);
  });

  test("is true when the Anthropic account pool is on", () => {
    expect(canHopNativeClaudePierce(baseConfig({ anthropicAccountPool: { enabled: true } }))).toBe(true);
  });

  test("is true when the Anthropic provider has a hop chain", () => {
    const config = anthropicFallbackConfig();
    expect(canHopNativeClaudePierce(config)).toBe(true);
    expect(config.providerCooldowns).toBeUndefined();
    expect(config.keyPoolCooldowns).toBeUndefined();
    expect(config.combos).toBeUndefined();
  });

  test("is false when the Anthropic provider row is disabled", () => {
    const config = anthropicFallbackConfig();
    config.providers.anthropic!.disabled = true;
    expect(canHopNativeClaudePierce(config)).toBe(false);
  });
});

describe("resolveOutcome", () => {
  let home: string;
  const previousHome = process.env.OPENCODEX_HOME;

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
    restoreOpenCodexHome(previousHome);
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

  test("Meta AI and OpenCode Zen shaped openai-chat pools hop like any other key pool", () => {
    const now = 1_000_000;
    for (const [name, baseUrl] of [
      ["meta-ai", "https://api.meta.ai/v1"],
      ["opencode-zen", "https://opencode.ai/zen/v1"],
    ] as const) {
      const config = baseConfig({
        defaultProvider: name,
        providers: {
          [name]: {
            adapter: "openai-chat",
            baseUrl,
            apiKey: pool[0]!.key,
            apiKeyPool: pool,
          },
        },
      });
      const next = resolveOutcome({
        config,
        providerName: name,
        routedProvider: config.providers[name]!,
        status: 429,
        now,
        attemptedKey: pool[0]!.key,
      });
      expect(next?.apiKey).toBe(pool[1]!.key);
    }
  });

  test("selectKeyPoolCandidate is a no-op when the live key is eligible", () => {
    const config = poolConfig();
    expect(selectKeyPoolCandidate({
      config,
      providerName: "p",
      routedProvider: config.providers.p!,
    })).toEqual({ kind: "live" });
  });

  test("selectKeyPoolCandidate keeps a resolved env-ref secret on the live key", () => {
    const prevA = process.env.OCX_AVAIL_POOL_KEY_A;
    const prevB = process.env.OCX_AVAIL_POOL_KEY_B;
    process.env.OCX_AVAIL_POOL_KEY_A = pool[0]!.key;
    process.env.OCX_AVAIL_POOL_KEY_B = pool[1]!.key;
    try {
      const config = baseConfig({
        defaultProvider: "p",
        providers: {
          p: {
            adapter: "openai-chat",
            baseUrl: "https://p.example/v1",
            apiKey: "$OCX_AVAIL_POOL_KEY_A",
            apiKeyPool: [
              { id: "k1", key: "$OCX_AVAIL_POOL_KEY_A", addedAt: 1 },
              { id: "k2", key: "${OCX_AVAIL_POOL_KEY_B}", addedAt: 2 },
            ],
          },
        },
      });
      const routed = { ...config.providers.p!, apiKey: pool[0]!.key };
      expect(selectKeyPoolCandidate({
        config,
        providerName: "p",
        routedProvider: routed,
      })).toEqual({ kind: "live" });
      expect(config.providers.p!.apiKey).toBe("$OCX_AVAIL_POOL_KEY_A");
    } finally {
      if (prevA === undefined) delete process.env.OCX_AVAIL_POOL_KEY_A;
      else process.env.OCX_AVAIL_POOL_KEY_A = prevA;
      if (prevB === undefined) delete process.env.OCX_AVAIL_POOL_KEY_B;
      else process.env.OCX_AVAIL_POOL_KEY_B = prevB;
    }
  });

  test("selectKeyPoolCandidate hops an env-ref pool to the resolved next secret", () => {
    const prevA = process.env.OCX_AVAIL_POOL_KEY_A;
    const prevB = process.env.OCX_AVAIL_POOL_KEY_B;
    process.env.OCX_AVAIL_POOL_KEY_A = pool[0]!.key;
    process.env.OCX_AVAIL_POOL_KEY_B = pool[1]!.key;
    try {
      const config = baseConfig({
        defaultProvider: "p",
        providers: {
          p: {
            adapter: "openai-chat",
            baseUrl: "https://p.example/v1",
            apiKey: "$OCX_AVAIL_POOL_KEY_A",
            apiKeyPool: [
              { id: "k1", key: "$OCX_AVAIL_POOL_KEY_A", addedAt: 1 },
              { id: "k2", key: "${OCX_AVAIL_POOL_KEY_B}", addedAt: 2 },
            ],
          },
        },
      });
      const next = resolveOutcome({
        config,
        providerName: "p",
        routedProvider: { ...config.providers.p!, apiKey: pool[0]!.key },
        status: 429,
        now: 1_000_000,
        attemptedKey: pool[0]!.key,
        save: false,
      });
      expect(next?.apiKey).toBe(pool[1]!.key);
      expect(config.providers.p!.apiKey).toBe("${OCX_AVAIL_POOL_KEY_B}");
    } finally {
      if (prevA === undefined) delete process.env.OCX_AVAIL_POOL_KEY_A;
      else process.env.OCX_AVAIL_POOL_KEY_A = prevA;
      if (prevB === undefined) delete process.env.OCX_AVAIL_POOL_KEY_B;
      else process.env.OCX_AVAIL_POOL_KEY_B = prevB;
    }
  });

  test("selectKeyPoolCandidate reports all-cooled instead of forwarding the live key", () => {
    const now = 1_000_000;
    const config = poolConfig();
    resolveOutcome({
      config,
      providerName: "p",
      routedProvider: config.providers.p!,
      status: 429,
      now,
      attemptedKey: pool[0]!.key,
      save: false,
    });
    resolveOutcome({
      config,
      providerName: "p",
      routedProvider: config.providers.p!,
      status: 429,
      now,
      attemptedKey: pool[1]!.key,
      save: false,
    });
    const pick = selectKeyPoolCandidate({
      config,
      providerName: "p",
      routedProvider: { ...config.providers.p!, apiKey: pool[0]!.key },
      now: now + 1,
    });
    expect(pick.kind).toBe("all-cooled");
    if (pick.kind !== "all-cooled") return;
    expect(pick.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  test("records a hard-cap 429 on a single-key provider and surfaces", () => {
    const config = baseConfig({ defaultProvider: "a" });
    const next = resolveOutcome({
      config,
      providerName: "b",
      routedProvider: config.providers.b!,
      status: 429,
      now: 1_000_000,
      message: 'Error 429: {"code":"INFERENCE_CAP_ERROR","message":"weekly Clinepass limit. The limit resets in 1d 22h"}',
      save: false,
    });
    expect(next).toBeNull();
    expect(config.providers.b!.disabled).toBe(true);
    expect(config.providerCooldowns?.b?.reason).toBe("INFERENCE_CAP_ERROR");
  });

  test("does not disable a key-pool provider on a weekly cap while another key remains", () => {
    const config = poolConfig();
    resolveOutcome({
      config,
      providerName: "p",
      routedProvider: config.providers.p!,
      status: 429,
      now: 1_000_000,
      attemptedKey: pool[0]!.key,
      message: 'Error 429: {"code":"INFERENCE_CAP_ERROR","message":"weekly limit. The limit resets in 2d"}',
      save: false,
    });
    expect(config.providers.p!.disabled).toBeUndefined();
    expect(config.providerCooldowns?.p).toBeUndefined();
  });

  test("pauses a key-pool provider once every key is hard-capped", () => {
    const config = poolConfig();
    config.defaultProvider = "other";
    config.providers.other = {
      adapter: "openai-chat",
      baseUrl: "https://other.example/v1",
      apiKey: "ko",
    };
    const cap = 'Error 429: {"code":"INFERENCE_CAP_ERROR","message":"weekly limit. The limit resets in 2d"}';
    const now = 1_000_000;
    resolveOutcome({
      config,
      providerName: "p",
      routedProvider: config.providers.p!,
      status: 429,
      now,
      attemptedKey: pool[0]!.key,
      message: cap,
      save: false,
    });
    const last = resolveOutcome({
      config,
      providerName: "p",
      routedProvider: { ...config.providers.p!, apiKey: pool[1]!.key },
      status: 429,
      now,
      attemptedKey: pool[1]!.key,
      message: cap,
      save: false,
    });
    expect(last).toBeNull();
    expect(config.providers.p!.disabled).toBe(true);
    expect(config.providerCooldowns?.p?.reason).toBe("INFERENCE_CAP_ERROR");
  });

  test("402 cools the attempted key without hopping", () => {
    const config = poolConfig();
    const now = 1_000_000;
    const next = resolveOutcome({
      config,
      providerName: "p",
      routedProvider: config.providers.p!,
      status: 402,
      now,
      attemptedKey: pool[0]!.key,
      message: 'Error 402: {"code":"INFERENCE_CAP_ERROR","message":"weekly limit. The limit resets in 2d"}',
      save: false,
    });
    expect(next).toBeNull();
    expect(config.providers.p!.apiKey).toBe(pool[0]!.key);
    expect(inspectKeyPool(config, "p", now).keys.find(key => key.id === "k1")?.cooldownUntil).toBe(
      now + 2 * 24 * 60 * 60 * 1000,
    );
    expect(config.providers.p!.disabled).toBeUndefined();
  });
});

describe("recordCapOutcome", () => {
  test("is a no-op for ordinary rate limits", () => {
    const config = baseConfig();
    expect(recordCapOutcome({
      config,
      providerName: "b",
      status: 429,
      message: "Too many requests",
      save: false,
    })).toBeNull();
    expect(config.providers.b!.disabled).toBeUndefined();
  });

  test("default save uses persistConfig when routing config is a clone", () => {
    const live = baseConfig();
    const clone = {
      ...live,
      combos: { synth: { targets: [{ provider: "a", model: "m1" }] } },
    };
    const saved: configModule.OcxConfig[] = [];
    const spy = spyOn(configModule, "saveConfigPreservingClaudeCode").mockImplementation((cfg) => {
      saved.push(cfg);
    });
    try {
      recordCapOutcome({
        config: clone,
        persistConfig: live,
        providerName: "b",
        status: 429,
        message: 'Error 429: {"code":"INFERENCE_CAP_ERROR","message":"weekly limit. The limit resets in 1d 22h"}',
      });
      expect(saved).toEqual([live]);
      expect(live.combos).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  test("warns without echoing the persist error when save throws", () => {
    const config = baseConfig();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      expect(recordCapOutcome({
        config,
        providerName: "b",
        status: 429,
        message: 'Error 429: {"code":"INFERENCE_CAP_ERROR","message":"weekly limit. The limit resets in 2d"}',
        save: () => {
          throw new Error("disk-secret-path");
        },
      })).toBeNull();
      expect(warnings.some(line => line.includes("Failed to persist provider cap cooldown"))).toBe(true);
      expect(warnings.join("\n")).not.toContain("disk-secret-path");
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("handleResponses records cap-cooldown", () => {
  let home: string;
  const previousHome = process.env.OPENCODEX_HOME;
  const previousFetch = globalThis.fetch;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-cap-turn-"));
    process.env.OPENCODEX_HOME = home;
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
    restoreOpenCodexHome(previousHome);
    rmSync(home, { recursive: true, force: true });
  });

  test("disables a single-key provider after a weekly inference cap", async () => {
    globalThis.fetch = (async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("api.cline.bot")) {
        return new Response(
          JSON.stringify({
            error: { code: "INFERENCE_CAP_ERROR", message: "weekly Clinepass limit. The limit resets in 1d 22h" },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        );
      }
      return previousFetch(input as Request);
    }) as typeof fetch;

    const config = baseConfig({
      defaultProvider: "a",
      providers: {
        a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"] },
        "cline-pass": {
          adapter: "openai-chat",
          baseUrl: "https://api.cline.bot/v1",
          apiKey: "k-cline",
          models: ["cline-sonnet"],
        },
      },
    });
    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "cline-pass/cline-sonnet", input: "hi", stream: false }),
      }),
      config,
      { model: "", provider: "" },
    );
    expect(response.status).toBe(429);
    expect(config.providers["cline-pass"]?.disabled).toBe(true);
    expect(config.providerCooldowns?.["cline-pass"]?.reason).toBe("INFERENCE_CAP_ERROR");
  });
});

describe("inspectKeyPool", () => {
  let home: string;
  const previousHome = process.env.OPENCODEX_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-inspect-keys-"));
    process.env.OPENCODEX_HOME = home;
    clearKeyPoolCooldowns();
  });

  afterEach(() => {
    restoreOpenCodexHome(previousHome);
    rmSync(home, { recursive: true, force: true });
    clearKeyPoolCooldowns();
  });

  test("marks a cooled key after a pool hop", () => {
    const now = 1_000_000;
    const config = baseConfig({
      defaultProvider: "p",
      providers: {
        p: {
          adapter: "openai-chat",
          baseUrl: "https://p.example/v1",
          apiKey: "key-alpha-000111222333",
          apiKeyPool: [
            { id: "k1", key: "key-alpha-000111222333", addedAt: 1 },
            { id: "k2", key: "key-beta-444555666777", addedAt: 2 },
          ],
        },
      },
    });
    resolveOutcome({
      config,
      providerName: "p",
      routedProvider: config.providers.p!,
      status: 429,
      now,
      attemptedKey: "key-alpha-000111222333",
      save: false,
    });
    const view = inspectKeyPool(config, "p", now + 1);
    const cooled = view.keys.find(key => key.id === "k1");
    const live = view.keys.find(key => key.id === "k2");
    expect(cooled?.cooldownUntil).toBeGreaterThan(now);
    expect(live?.cooldownUntil).toBeUndefined();
    expect(live?.active).toBe(true);
  });

  test("inspectAvailability counts cooling keys and the first hop", () => {
    const now = 1_000_000;
    const config = baseConfig({
      defaultProvider: "p",
      providers: {
        p: {
          adapter: "openai-chat",
          baseUrl: "https://p.example/v1",
          apiKey: "key-alpha-000111222333",
          apiKeyPool: [
            { id: "k1", key: "key-alpha-000111222333", addedAt: 1 },
            { id: "k2", key: "key-beta-444555666777", addedAt: 2 },
          ],
          fallback: [{ provider: "b", model: "m2" }],
        },
      },
    });
    resolveOutcome({
      config,
      providerName: "p",
      routedProvider: config.providers.p!,
      status: 429,
      now,
      attemptedKey: "key-alpha-000111222333",
      save: false,
    });
    const view = inspectAvailability(config, now + 1).providers.find(row => row.name === "p");
    expect(view?.keyPoolCount).toBe(2);
    expect(view?.coolingKeyCount).toBe(1);
    expect(view?.hopProvider).toBe("b");
  });

  test("inspectAvailability counts a bare apiKey when apiKeyPool is empty", () => {
    const config = baseConfig({
      providers: {
        a: {
          adapter: "openai-chat",
          baseUrl: "https://a.example/v1",
          apiKey: "ka",
          apiKeyPool: [],
          models: ["m1"],
        },
      },
    });
    const view = inspectAvailability(config).providers.find(row => row.name === "a");
    expect(view?.keyPoolCount).toBe(1);
  });
});

describe("selectCandidate", () => {
  let home: string;
  const previousHome = process.env.OPENCODEX_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-select-candidate-"));
    process.env.OPENCODEX_HOME = home;
    clearKeyPoolCooldowns();
  });

  afterEach(() => {
    restoreOpenCodexHome(previousHome);
    rmSync(home, { recursive: true, force: true });
    clearKeyPoolCooldowns();
  });

  test("skips a cooling key on first pick", async () => {
    const now = 1_000_000;
    const config = baseConfig({
      defaultProvider: "p",
      providers: {
        p: {
          adapter: "openai-chat",
          baseUrl: "https://p.example/v1",
          apiKey: "key-alpha-000111222333",
          apiKeyPool: [
            { id: "k1", key: "key-alpha-000111222333", addedAt: 1 },
            { id: "k2", key: "key-beta-444555666777", addedAt: 2 },
          ],
        },
      },
    });
    resolveOutcome({
      config,
      providerName: "p",
      routedProvider: config.providers.p!,
      status: 429,
      now,
      attemptedKey: "key-alpha-000111222333",
      save: false,
    });
    config.providers.p!.apiKey = "key-alpha-000111222333";
    const result = await selectCandidate({
      config,
      providerName: "p",
      routedProvider: config.providers.p!,
      now: now + 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provider.apiKey).toBe("key-beta-444555666777");
  });

  test("with headers and no Codex mode forwards the caller bearer then skips a cooling key", async () => {
    const now = 1_000_000;
    const config = baseConfig({
      defaultProvider: "p",
      providers: {
        p: {
          adapter: "openai-chat",
          baseUrl: "https://p.example/v1",
          apiKey: "key-alpha-000111222333",
          apiKeyPool: [
            { id: "k1", key: "key-alpha-000111222333", addedAt: 1 },
            { id: "k2", key: "key-beta-444555666777", addedAt: 2 },
          ],
        },
      },
    });
    resolveOutcome({
      config,
      providerName: "p",
      routedProvider: config.providers.p!,
      status: 429,
      now,
      attemptedKey: "key-alpha-000111222333",
      save: false,
    });
    config.providers.p!.apiKey = "key-alpha-000111222333";
    const result = await selectCandidate({
      config,
      providerName: "p",
      routedProvider: config.providers.p!,
      now: now + 1,
      headers: new Headers({ authorization: "Bearer client-token" }),
      modelId: "m1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.authCtx).toEqual({ kind: "main", accountId: null });
    expect(result.headers?.get("authorization")).toBe("Bearer client-token");
    expect(result.provider.apiKey).toBe("key-beta-444555666777");
  });

  test("Direct without a caller bearer is a Codex domain failure", async () => {
    const result = await selectCandidate({
      config: baseConfig(),
      providerName: "a",
      routedProvider: baseConfig().providers.a!,
      headers: new Headers(),
      mode: "direct",
      modelId: "gpt-5",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("codex-direct-auth");
  });

  test("fails closed when every pool key is cooling", async () => {
    const now = 1_000_000;
    const config = baseConfig({
      defaultProvider: "p",
      providers: {
        p: {
          adapter: "openai-chat",
          baseUrl: "https://p.example/v1",
          apiKey: "key-alpha-000111222333",
          apiKeyPool: [
            { id: "k1", key: "key-alpha-000111222333", addedAt: 1 },
            { id: "k2", key: "key-beta-444555666777", addedAt: 2 },
          ],
        },
      },
    });
    resolveOutcome({
      config,
      providerName: "p",
      routedProvider: config.providers.p!,
      status: 429,
      now,
      attemptedKey: "key-alpha-000111222333",
      save: false,
    });
    resolveOutcome({
      config,
      providerName: "p",
      routedProvider: config.providers.p!,
      status: 429,
      now,
      attemptedKey: "key-beta-444555666777",
      save: false,
    });
    const result = await selectCandidate({
      config,
      providerName: "p",
      routedProvider: { ...config.providers.p!, apiKey: "key-alpha-000111222333" },
      now: now + 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("key-all-cooled");
    if (result.kind !== "key-all-cooled") return;
    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  test("keeps a resolved env-ref secret instead of writing the $VAR back onto the turn", async () => {
    const prevA = process.env.OCX_AVAIL_POOL_KEY_A;
    const prevB = process.env.OCX_AVAIL_POOL_KEY_B;
    process.env.OCX_AVAIL_POOL_KEY_A = "key-alpha-000111222333";
    process.env.OCX_AVAIL_POOL_KEY_B = "key-beta-444555666777";
    try {
      const config = baseConfig({
        defaultProvider: "p",
        providers: {
          p: {
            adapter: "openai-chat",
            baseUrl: "https://p.example/v1",
            apiKey: "$OCX_AVAIL_POOL_KEY_A",
            apiKeyPool: [
              { id: "k1", key: "$OCX_AVAIL_POOL_KEY_A", addedAt: 1 },
              { id: "k2", key: "${OCX_AVAIL_POOL_KEY_B}", addedAt: 2 },
            ],
          },
        },
      });
      const result = await selectCandidate({
        config,
        providerName: "p",
        routedProvider: { ...config.providers.p!, apiKey: "key-alpha-000111222333" },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.provider.apiKey).toBe("key-alpha-000111222333");
      expect(config.providers.p!.apiKey).toBe("$OCX_AVAIL_POOL_KEY_A");
    } finally {
      if (prevA === undefined) delete process.env.OCX_AVAIL_POOL_KEY_A;
      else process.env.OCX_AVAIL_POOL_KEY_A = prevA;
      if (prevB === undefined) delete process.env.OCX_AVAIL_POOL_KEY_B;
      else process.env.OCX_AVAIL_POOL_KEY_B = prevB;
    }
  });

  test("maps all-cooled keys to HTTP 429 with Retry-After", async () => {
    const response = selectCandidateFailResponse(
      { ok: false, kind: "key-all-cooled", retryAfterSeconds: 12 },
      { providerName: "p", config: baseConfig() },
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("12");
    const body = await response.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.message).toBe("All API keys are temporarily rate-limited");
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
    restoreOpenCodexHome(previousHome);
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

describe("handleResponses anthropic oauth pool", () => {
  let home: string;
  const previousHome = process.env.OPENCODEX_HOME;
  const previousFetch = globalThis.fetch;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-availability-anthropic-pool-"));
    process.env.OPENCODEX_HOME = home;
    clearAnthropicAccountPoolState();
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
    clearAnthropicAccountPoolState();
    restoreOpenCodexHome(previousHome);
    rmSync(home, { recursive: true, force: true });
  });

  test("an exhausted pool surfaces the last upstream 429 body", async () => {
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

    globalThis.fetch = (async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("api.anthropic.com")) {
        return new Response(
          JSON.stringify({
            type: "error",
            error: { type: "rate_limit_error", message: "anthropic weekly limit" },
          }),
          { status: 429, headers: { "content-type": "application/json", "retry-after": "12" } },
        );
      }
      return previousFetch(input as Request);
    }) as typeof fetch;

    const config = baseConfig({
      defaultProvider: "anthropic",
      providers: {
        anthropic: {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          authMode: "oauth",
          models: ["claude-sonnet-4-6"],
        },
      },
      anthropicAccountPool: { enabled: true },
    });
    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "anthropic/claude-sonnet-4-6", input: "hi", stream: false }),
      }),
      config,
      { model: "", provider: "" },
    );
    expect(response.status).toBe(429);
    const text = await response.text();
    expect(text.toLowerCase()).not.toContain("unknown error");
    expect(text).toContain("anthropic weekly limit");
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
