import { isAnthropicAccountPoolEnabled } from "../oauth/anthropic-routing";
import { providerFallbackPlan, usableProviderFallbackTargets } from "../providers/fallback";
import { autoRouterEnabled, reorderChainTargets, type ProviderLatencyHistory } from "../router-auto";
import type { OcxComboTarget, OcxConfig } from "../types";

/**
 * A hop chain for this Responses turn: user combo or provider fallback list.
 * The NUL synthetic combo stays inside this module; callers do not classify combo vs fallback.
 */
export type HopChain = {
  comboId: string;
  config: OcxConfig;
  /** True when the chain stands in for a plain provider request (fallback list). */
  preservePhysicalIdentity: boolean;
};

/** Injectable latency-history seam; production wires the usage-log p50 reader. */
let latencyHistory: ProviderLatencyHistory | null = null;

export function installAutoRouterLatencyHistory(history: ProviderLatencyHistory | null): void {
  latencyHistory = history;
}

/**
 * Pre-request selection of a multi-target hop chain. Null means a single-candidate
 * request: the caller continues with the routed provider.
 *
 * With `router.mode: "auto"` the fallback targets are re-scored (cost/latency/quality)
 * and reordered before the synthetic combo is built — the hop loop then runs unchanged,
 * inheriting Fase C cooldowns/allowed-fails as-is. The FIRST target stays the request's
 * own route only when it also scores first: auto-router may demote the entry provider
 * when evidence says another candidate is better. Ties keep configured order.
 */
export function selectHopChain(
  config: OcxConfig,
  route: { provider: string; modelId: string },
): HopChain | null {
  const plan = providerFallbackPlan(config, route);
  if (!plan) return null;

  if (autoRouterEnabled(config)) {
    const targets = usableProviderFallbackTargets(config, route);
    // Cooldown keys embed BOTH the synthetic combo id and the target (`comboId\0provider/model`),
    // so reordering under the SAME id keeps Fase C cooldown state live across requests regardless
    // of order — exactly the "reuse allowed_fails/cooldown_time from Fase C" requirement.
    if (targets) {
      const now = Date.now();
      if (latencyHistory) {
        const scored = reorderChainTargets(config, targets, latencyHistory, now).map(s => s.target);
        if (scored.some((target, i) => target.provider !== targets[i]!.provider || target.model !== targets[i]!.model)) {
          const combos = { ...plan.config.combos };
          combos[plan.comboId]!.targets = scored;
          return {
            comboId: plan.comboId,
            config: { ...plan.config, combos },
            preservePhysicalIdentity: true,
          };
        }
      }
    }
  }

  return {
    comboId: plan.comboId,
    config: plan.config,
    preservePhysicalIdentity: true,
  };
}

/**
 * Whether a native Claude pierce (caller sk-ant-) may hop into the provider table
 * after overload. The pierce itself stays on the turn; Availability only answers
 * whether another candidate exists. 529-only: native 429 stays on the caller account.
 *
 * Read-only: does not clone config or attach empty cooldown bags. A disabled
 * anthropic row or a hop chain with no remaining usable targets returns false.
 */
export function canHopNativeClaudePierce(config: OcxConfig): boolean {
  if (isAnthropicAccountPoolEnabled(config)) return true;
  const anthropic = config.providers.anthropic;
  if (!anthropic) return false;
  const modelId = anthropic.defaultModel ?? anthropic.models?.[0] ?? "claude";
  return usableProviderFallbackTargets(config, { provider: "anthropic", modelId }) !== null;
}
