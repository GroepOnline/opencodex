/**
 * Auto-router (Fase E): scoring math + hop-chain reordering. Opt-in via
 * `router.mode: "auto"`; default off keeps configured fallback order byte-for-byte.
 */
import { describe, expect, test } from "bun:test";
import {
  autoRouterEnabled,
  autoRouterWeights,
  blendedCostPer1k,
  qualityTierForModel,
  reorderChainTargets,
  scoreRouterCandidates,
  type ProviderLatencyHistory,
} from "../src/router-auto";
import type { OcxComboTarget, OcxConfig } from "../src/types";

function configWith(overrides: Partial<OcxConfig["router"]> = {}): OcxConfig {
  return {
    port: 10100,
    providers: {
      alpha: { adapter: "openai-chat", baseUrl: "https://a.test", models: ["m-a"], defaultModel: "m-a" },
    },
    router: { mode: "auto", ...overrides },
  } as unknown as OcxConfig;
}

function history(samples: Record<string, number>): ProviderLatencyHistory {
  return {
    p50DurationMs: (provider, model) => samples[`${provider}/${model}`] ?? null,
  };
}

describe("quality tiers", () => {
  test("frontier families tier 0, mid tier 1, small/fast tier 2, unknown defaults", () => {
    expect(qualityTierForModel("claude-opus-4-6")).toBe(0);
    expect(qualityTierForModel("gpt-5.6-sol")).toBe(0);
    expect(qualityTierForModel("deepseek-v4-pro")).toBe(0);
    expect(qualityTierForModel("claude-sonnet-4-6")).toBe(1);
    expect(qualityTierForModel("gpt-4o-mini")).toBe(1);
    expect(qualityTierForModel("gemini-2.5-flash")).toBe(1);
    expect(qualityTierForModel("totally-unknown-model")).toBe(2); // conservative middle
  });
});

describe("scoring", () => {
  test("cheapest fastest best-quality candidate wins with default weights", () => {
    const scored = scoreRouterCandidates([
      { provider: "a", model: "expensive-slow", costPer1k: 0.01, p50DurationMs: 5000 },
      { provider: "b", model: "cheap-fast-mini", costPer1k: 0.0001, p50DurationMs: 400 },
    ], autoRouterWeights(configWith()));
    expect(scored[0]!.target).toEqual({ provider: "b", model: "cheap-fast-mini" });
  });

  test("no latency history scores neutral 0.5, not best", () => {
    const scored = scoreRouterCandidates([
      { provider: "a", model: "frontier", costPer1k: 0.001, p50DurationMs: null },
      { provider: "b", model: "small-fast", costPer1k: 0.0005, p50DurationMs: 100 },
    ], autoRouterWeights(configWith()));
    const frontier = scored.find(s => s.target.model === "frontier")!;
    expect(frontier.components.latency).toBe(0.5);
  });

  test("weights are clamped to 0..10 and non-numbers fall back to defaults", () => {
    const weights = autoRouterWeights(configWith({
      weights: { cost: 99 as number, latency: -3 as number, quality: undefined },
    }));
    expect(weights.cost).toBe(10);
    expect(weights.latency).toBe(0);
    expect(weights.quality).toBe(1); // default
  });

  test("latency weight 0 ignores measured latency entirely", () => {
    const weights = { cost: 0, latency: 0, quality: 0 };
    // All-zero weights → all scores 0 → stable order preserved (tie keeps configured order).
    const scored = scoreRouterCandidates([
      { provider: "a", model: "slow-one", costPer1k: 0.01, p50DurationMs: 9000 },
      { provider: "b", model: "fast-two", costPer1k: 0.0001, p50DurationMs: 10 },
    ], weights);
    expect(scored.map(s => s.target.model)).toEqual(["slow-one", "fast-two"]);
  });

  test("blendedCostPer1k uses free pricing for subscription providers", () => {
    expect(blendedCostPer1k("ollama-cloud", "anything")).toBe(0);
    expect(blendedCostPer1k("anthropic", "claude-opus-4-6")).toBeGreaterThan(0);
  });
});

describe("reorderChainTargets", () => {
  const targets: OcxComboTarget[] = [
    { provider: "alpha", model: "alpha-frontier" },   // entry route: expensive, slow
    { provider: "beta", model: "beta-cheap-fast" },   // measured cheap+fast
    { provider: "gamma", model: "gamma-unmeasured" }, // no history → neutral latency
  ];

  test("reorders by composite score when evidence exists", () => {
    const config = configWith();
    const ordered = reorderChainTargets(config, targets, history({
      "alpha/alpha-frontier": 6000,
      "beta/beta-cheap-fast": 300,
    }));
    expect(ordered[0]!.target.provider).toBe("beta");
  });

  test("ties keep configured order (stable sort)", () => {
    const config = configWith({ weights: { cost: 0, latency: 0, quality: 0 } });
    const ordered = reorderChainTargets(config, targets, history({
      "alpha/alpha-frontier": 6000,
      "beta/beta-cheap-fast": 300,
    }));
    expect(ordered.map(s => s.target.provider)).toEqual(["alpha", "beta", "gamma"]);
  });
});

describe("opt-in gate", () => {
  test("disabled unless mode is exactly auto", () => {
    expect(autoRouterEnabled(configWith())).toBe(true);
    expect(autoRouterEnabled({ port: 10100, providers: {} } as unknown as OcxConfig)).toBe(false);
    expect(autoRouterEnabled(configWith({ mode: "off" }))).toBe(false);
  });
});
