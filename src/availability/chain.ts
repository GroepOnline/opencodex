import { isAnthropicAccountPoolEnabled } from "../oauth/anthropic-routing";
import { providerFallbackPlan, usableProviderFallbackTargets } from "../providers/fallback";
import type { OcxConfig } from "../types";

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
