/**
 * Auto-router scoring (Fase E — opt-in via `router.mode: "auto"`).
 *
 * Reorders the targets of a per-provider fallback hop chain by a config-weighted score:
 *   score = wCost*cost + wLatency*latency + wQuality*quality   (lower wins)
 *
 * All three inputs are normalized to 0..1 before weighting so the weights are comparable:
 * - cost:    estimated EUR per 1k mixed tokens from src/usage/pricing.ts, scaled against the
 *            most expensive candidate in the chain (relative, not absolute).
 * - latency: p50 durationMs for that provider/model from the usage log within
 *            `router.latencyWindowMs`, relative to the slowest candidate; no history → 0.5
 *            (neutral middle, so measured candidates win/lose on evidence only).
 * - quality: static family-tier table below (0 = best). Deliberately coarse: the table
 *            exists to keep the router from systematically downgrading a frontier model to
 *            a cheap weak one, not to rank within a family.
 *
 * Fase C reuse: reordering happens BEFORE the combo hop loop runs, and cooldowns/
 * allowed-fails live in the existing combo engine — a scored chain hops exactly like a
 * configured one. User combos keep their explicit order; only fallback chains reorder.
 */

import { lookupPricing } from "./usage/pricing";
import type { OcxComboTarget, OcxConfig } from "./types";

export interface AutoRouterWeights {
  cost: number;
  latency: number;
  quality: number;
}

export const DEFAULT_AUTO_ROUTER_WEIGHTS: AutoRouterWeights = { cost: 1, latency: 1, quality: 1 };
export const DEFAULT_LATENCY_WINDOW_MS = 7 * 86_400_000;
const MAX_WEIGHT = 10;

/** Static capability tiers, 0 (frontier) .. 3 (small/fast). Unknown models: 2. */
const QUALITY_TIER_RULES: Array<{ pattern: RegExp; tier: number }> = [
  // Frontier / flagship (prefix-anchored so "x-sonnet-custom" cannot ride along)
  { pattern: /^(claude-opus-|gpt-5(?!.*mini)|gpt-4o$|gemini-2\.5-pro|grok-4|deepseek-v4-pro|kimi-k3)/i, tier: 0 },
  // Strong mid-tier
  { pattern: /^(claude-sonnet-|[a-z0-9-]*haiku-4$|gpt-4o-mini$|gemini-2\.5-flash$|deepseek-v4-flash$|kimi-k2)/i, tier: 1 },
  // Small / fast (substring keywords)
  { pattern: /(mini|flash|nano|lite|small|8b|7b|-fast)/i, tier: 2 },
];

export function qualityTierForModel(modelId: string): number {
  for (const rule of QUALITY_TIER_RULES) {
    if (rule.pattern.test(modelId)) return rule.tier;
  }
  return 2;
}

export function autoRouterWeights(config: OcxConfig): AutoRouterWeights {
  const raw = config.router?.weights ?? {};
  const clamp = (value: unknown, fallback: number): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(Math.max(value, 0), MAX_WEIGHT);
  };
  return {
    cost: clamp(raw.cost, DEFAULT_AUTO_ROUTER_WEIGHTS.cost),
    latency: clamp(raw.latency, DEFAULT_AUTO_ROUTER_WEIGHTS.latency),
    quality: clamp(raw.quality, DEFAULT_AUTO_ROUTER_WEIGHTS.quality),
  };
}

export function autoRouterEnabled(config: OcxConfig): boolean {
  return config.router?.mode === "auto";
}

/**
 * Mixed-token EUR estimate per 1k tokens (75/25 input/output split — a cheap, stable proxy
 * that matches typical coding-assistant traffic better than either pure endpoint).
 */
export function blendedCostPer1k(provider: string, modelId: string): number {
  const p = lookupPricing(provider, modelId);
  return 0.75 * p.inputPer1k + 0.25 * p.outputPer1k;
}

export interface RouterTargetScore {
  target: OcxComboTarget;
  /** Weighted composite; lower is better. */
  score: number;
  /** Normalized 0..1 components (for observability endpoints/tests). */
  components: { cost: number; latency: number; quality: number };
}

export interface RouterScoreInput {
  provider: string;
  model: string;
  costPer1k: number;
  /** p50 duration in ms, or null when there is no history inside the window. */
  p50DurationMs: number | null;
}

/**
 * Score one candidate set, best (lowest) first. Stable on ties so equally-scored
 * candidates keep their input order. Exported for tests + the management inspect endpoint.
 */
export function scoreRouterCandidates(
  candidates: RouterScoreInput[],
  weights: AutoRouterWeights,
): RouterTargetScore[] {
  if (candidates.length === 0) return [];
  const maxCost = Math.max(...candidates.map(c => c.costPer1k), 0);
  const maxLatency = Math.max(...candidates.map(c => c.p50DurationMs ?? 0), 0);
  return candidates.map(candidate => {
    const cost = maxCost > 0 ? candidate.costPer1k / maxCost : 0;
    const latency = candidate.p50DurationMs === null
      ? 0.5
      : maxLatency > 0 ? candidate.p50DurationMs / maxLatency : 0;
    const quality = qualityTierForModel(candidate.model) / 3;
    return {
      target: { provider: candidate.provider, model: candidate.model },
      score: weights.cost * cost + weights.latency * latency + weights.quality * quality,
      components: { cost, latency, quality },
    };
  }).toSorted((a, b) => a.score - b.score || 0);
}

/**
 * Reorder fallback-chain targets by score (stable on ties — preserves configured order for
 * equally-scored targets, so an all-free/all-unmeasured chain behaves exactly as today).
 */
export function reorderChainTargets(
  config: OcxConfig,
  targets: OcxComboTarget[],
  history: ProviderLatencyHistory,
  now = Date.now(),
): RouterTargetScore[] {
  const weights = autoRouterWeights(config);
  const windowMs = typeof config.router?.latencyWindowMs === "number"
    && Number.isFinite(config.router.latencyWindowMs)
    ? Math.max(config.router.latencyWindowMs, 60_000)
    : DEFAULT_LATENCY_WINDOW_MS;
  const inputs = targets.map(target => ({
    provider: target.provider,
    model: target.model,
    costPer1k: blendedCostPer1k(target.provider, target.model),
    p50DurationMs: history.p50DurationMs(target.provider, target.model, now - windowMs),
  }));
  return scoreRouterCandidates(inputs, weights);
}

/** Latency-history lookup seam (kept injectable so tests need no usage log). */
export interface ProviderLatencyHistory {
  /** p50 duration in ms for this provider/model since `sinceMs` (epoch), or null without data. */
  p50DurationMs(provider: string, model: string, sinceMs: number): number | null;
}
