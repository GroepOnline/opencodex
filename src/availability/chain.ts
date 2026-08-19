import { getCombo } from "../combos/types";
import { providerFallbackPlan } from "../providers/fallback";
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

export function hopChainTargets(chain: HopChain): OcxComboTarget[] {
  return getCombo(chain.config, chain.comboId)?.targets ?? [];
}

/**
 * Pre-request selection of a multi-target hop chain. Null means a single-candidate
 * request: the caller continues with the routed provider.
 */
export function selectHopChain(
  config: OcxConfig,
  route: { provider: string; modelId: string },
): HopChain | null {
  const plan = providerFallbackPlan(config, route);
  if (!plan) return null;
  return {
    comboId: plan.comboId,
    config: plan.config,
    preservePhysicalIdentity: true,
  };
}
