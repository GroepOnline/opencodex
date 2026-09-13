import { DEFAULT_SUBAGENT_MODELS, hasOwnProvider } from "../config";
import { comboModelId, resolveComboId } from "../combos";
import { SUPPORTED_NATIVE_OPENAI_SLUGS } from "../codex/catalog/metadata";
import { knownModelIdsForProvider, routeModel } from "../router";
import { decodeRoutedModelId } from "../providers/slug-codec";
import type { OcxComboTarget, OcxConfig } from "../types";

export const CLAUDE_DYNAMIC_AGENT_ROUTE = "dynamic";
// Reserved request-local id. This value is never persisted or exposed by management APIs.
const DYNAMIC_COMBO_ID = "claude-agent-dynamic-v1";

function dynamicAgentTargets(config: OcxConfig): OcxComboTarget[] {
  const roster = config.subagentModels === undefined
    ? DEFAULT_SUBAGENT_MODELS
    : config.subagentModels;
  const targets: OcxComboTarget[] = [];
  const seen = new Set<string>();

  for (const entry of roster) {
    if (targets.length >= 5) break;
    if (typeof entry !== "string") continue;
    const model = entry.trim();
    if (!model || resolveComboId(config, model)) continue;
    const slash = model.indexOf("/");
    if (slash < 0) {
      const nativeProvider = config.providers.openai;
      if (
        !SUPPORTED_NATIVE_OPENAI_SLUGS.has(model)
        || !nativeProvider
        || nativeProvider.disabled === true
      ) continue;
      const key = `openai/${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ provider: "openai", model });
      continue;
    }
    if (slash === 0) continue;
    const providerName = model.slice(0, slash);
    const requestedModel = model.slice(slash + 1);
    if (!hasOwnProvider(config.providers, providerName)) continue;
    const provider = config.providers[providerName];
    if (provider.disabled === true) continue;
    const knownModels = knownModelIdsForProvider(providerName, provider);
    const decodedModel = decodeRoutedModelId(requestedModel, knownModels);
    if (
      !knownModels.includes(model)
      && !knownModels.includes(requestedModel)
      && !knownModels.includes(decodedModel)
    ) continue;
    try {
      const route = routeModel(config, model);
      if (route.combo) continue;
      const key = `${route.providerName}/${route.modelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ provider: route.providerName, model: route.modelId });
    } catch {
      // A stale roster entry must not take the entire dynamic lane down.
    }
  }
  return targets;
}

/**
 * Build the request-local virtual route used by generated `ocx-auto` agents.
 * The configured roster is an explicit allowlist; OCX never discovers an
 * unapproved paid route here. Round-robin removes a durable preferred model,
 * while the combo engine supplies bounded failover and shared cooldowns.
 */
export function buildClaudeDynamicAgentRoute(
  config: OcxConfig,
): { config: OcxConfig; model: string } | null {
  const targets = dynamicAgentTargets(config);
  if (targets.length === 0) return null;
  return {
    config: {
      ...config,
      combos: {
        ...config.combos,
        [DYNAMIC_COMBO_ID]: {
          targets,
          strategy: "round-robin",
          stickyLimit: 1,
        },
      },
    },
    model: comboModelId(DYNAMIC_COMBO_ID),
  };
}
