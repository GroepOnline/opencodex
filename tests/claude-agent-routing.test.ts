import { describe, expect, test } from "bun:test";
import { buildClaudeDynamicAgentRoute } from "../src/claude/agent-routing";
import { getCombo } from "../src/combos";
import { getDefaultConfig } from "../src/config";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

function provider(models: string[], disabled = false): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    models,
    ...(disabled ? { disabled: true } : {}),
  };
}

function cfg(extra: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: {
      a: provider(["alpha", "shared"]),
      b: provider(["beta"]),
      off: provider(["offline"], true),
    },
    ...extra,
  } as OcxConfig;
}

describe("Claude dynamic agent route", () => {
  test("builds a backend-neutral round-robin combo from the approved roster", () => {
    const dynamic = buildClaudeDynamicAgentRoute(cfg({
      subagentModels: ["a/alpha", "b/beta", "a/alpha"],
    }));
    expect(dynamic).not.toBeNull();
    expect(dynamic!.model.startsWith("combo/claude-agent-dynamic")).toBe(true);
    expect(getCombo(dynamic!.config, dynamic!.model.slice("combo/".length))).toMatchObject({
      strategy: "round-robin",
      stickyLimit: 1,
      targets: [
        { provider: "a", model: "alpha", weight: 1 },
        { provider: "b", model: "beta", weight: 1 },
      ],
    });
  });

  test("uses the shipped native default roster when no custom roster is configured", () => {
    const config = getDefaultConfig();
    delete config.subagentModels;
    const dynamic = buildClaudeDynamicAgentRoute(config);
    expect(dynamic).not.toBeNull();
    expect(getCombo(dynamic!.config, dynamic!.model.slice("combo/".length))?.targets)
      .toEqual([
        { provider: "openai", model: "gpt-5.5", weight: 1 },
        { provider: "openai", model: "gpt-5.6-sol", weight: 1 },
        { provider: "openai", model: "gpt-5.6-terra", weight: 1 },
        { provider: "openai", model: "gpt-5.6-luna", weight: 1 },
        { provider: "openai", model: "gpt-5.4-mini", weight: 1 },
      ]);
  });

  test("does not admit an unknown bare model through the default provider", () => {
    expect(buildClaudeDynamicAgentRoute(cfg({ subagentModels: ["unknown-model"] }))).toBeNull();
  });

  test("accepts picker-encoded routed slugs but rejects unknown encoded models", () => {
    const config = cfg({
      providers: {
        ...cfg().providers,
        nvidia: provider(["moonshotai/kimi-k2.6"]),
      },
      subagentModels: [
        "nvidia/moonshotai-kimi-k2.6",
        "nvidia/unlisted-model",
      ],
    });
    const dynamic = buildClaudeDynamicAgentRoute(config);
    expect(dynamic).not.toBeNull();
    expect(getCombo(dynamic!.config, dynamic!.model.slice("combo/".length))?.targets)
      .toEqual([
        { provider: "nvidia", model: "moonshotai/kimi-k2.6", weight: 1 },
      ]);
  });

  test("drops disabled, stale, nested-combo, and duplicate routes without discovering extras", () => {
    const config = cfg({
      subagentModels: ["off/offline", "missing/model", "a/alpha", "a/alpha", "combo/elsewhere"],
      combos: {
        elsewhere: { targets: [{ provider: "b", model: "beta" }] },
      },
    });
    const dynamic = buildClaudeDynamicAgentRoute(config);
    expect(dynamic).not.toBeNull();
    const combo = getCombo(dynamic!.config, dynamic!.model.slice("combo/".length));
    expect(combo?.targets).toEqual([{ provider: "a", model: "alpha", weight: 1 }]);
    expect(config.combos).toEqual({
      elsewhere: { targets: [{ provider: "b", model: "beta" }] },
    });
  });

  test("collects up to five usable unique targets after filtering the roster", () => {
    const dynamic = buildClaudeDynamicAgentRoute(cfg({
      providers: {
        ...cfg().providers,
        c: provider(["gamma"]),
        d: provider(["delta"]),
        e: provider(["epsilon"]),
        f: provider(["zeta"]),
      },
      subagentModels: [
        "off/offline",
        "missing/model",
        "a/alpha",
        "a/alpha",
        "combo/elsewhere",
        "b/beta",
        "c/gamma",
        "d/delta",
        "e/epsilon",
        "f/zeta",
      ],
      combos: {
        elsewhere: { targets: [{ provider: "b", model: "beta" }] },
      },
    }));

    expect(dynamic).not.toBeNull();
    expect(getCombo(dynamic!.config, dynamic!.model.slice("combo/".length))?.targets)
      .toEqual([
        { provider: "a", model: "alpha", weight: 1 },
        { provider: "b", model: "beta", weight: 1 },
        { provider: "c", model: "gamma", weight: 1 },
        { provider: "d", model: "delta", weight: 1 },
        { provider: "e", model: "epsilon", weight: 1 },
      ]);
  });

  test("returns null for an explicitly empty or entirely unusable roster", () => {
    expect(buildClaudeDynamicAgentRoute(cfg({ subagentModels: [] }))).toBeNull();
    expect(buildClaudeDynamicAgentRoute(cfg({
      subagentModels: ["off/offline", "missing/model"],
    }))).toBeNull();
  });
});
