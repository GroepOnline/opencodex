import { DEFAULT_SUBAGENT_MODELS, hasOwnProvider } from "../config";
import { comboModelId, resolveComboId } from "../combos";
import { SUPPORTED_NATIVE_OPENAI_SLUGS } from "../codex/catalog/metadata";
import { knownModelIdsForProvider, routeModel } from "../router";
import { decodeRoutedModelId, slugEquals } from "../providers/slug-codec";
import type { OcxComboTarget, OcxConfig } from "../types";

// Reserved request-local id. This value is never persisted or exposed by management APIs.
const DYNAMIC_COMBO_ID = "claude-agent-dynamic-v1";

function isDisabledDynamicAgentModel(
  config: OcxConfig,
  model: string,
): boolean {
  const disabled = config.disabledModels ?? [];
  if (!model.includes("/")) {
    return disabled.some(
      (stored) => stored === model || slugEquals(stored, "openai", model),
    );
  }
  const slash = model.indexOf("/");
  return disabled.some((stored) => {
    if (stored === model) return true;
    const storedSlash = stored.indexOf("/");
    return (
      storedSlash > 0 &&
      stored.slice(0, storedSlash) === model.slice(0, slash) &&
      slugEquals(stored, model.slice(0, slash), model.slice(slash + 1))
    );
  });
}

function dynamicAgentRoster(config: OcxConfig): readonly string[] {
  return config.subagentModels === undefined
    ? DEFAULT_SUBAGENT_MODELS
    : config.subagentModels;
}

function rejectDynamicRosterEntry(config: OcxConfig, model: string): boolean {
  return !model || resolveComboId(config, model) != null;
}

function tryAddBareOpenAiTarget(
  config: OcxConfig,
  model: string,
  targets: OcxComboTarget[],
  seen: Set<string>,
): void {
  if (isDisabledDynamicAgentModel(config, model)) return;
  const nativeProvider = config.providers.openai;
  if (
    !SUPPORTED_NATIVE_OPENAI_SLUGS.has(model) ||
    !nativeProvider ||
    nativeProvider.disabled === true
  )
    return;
  const key = `openai/${model}`;
  if (seen.has(key)) return;
  seen.add(key);
  targets.push({ provider: "openai", model });
}

function tryAddRoutedProviderTarget(
  config: OcxConfig,
  model: string,
  targets: OcxComboTarget[],
  seen: Set<string>,
): void {
  const slash = model.indexOf("/");
  if (slash <= 0) return;
  const providerName = model.slice(0, slash);
  const requestedModel = model.slice(slash + 1);
  if (!hasOwnProvider(config.providers, providerName)) return;
  const provider = config.providers[providerName];
  if (provider.disabled === true) return;
  const knownModels = knownModelIdsForProvider(providerName, provider);
  const decodedModel = decodeRoutedModelId(requestedModel, knownModels);
  if (
    !knownModels.includes(model) &&
    !knownModels.includes(requestedModel) &&
    !knownModels.includes(decodedModel)
  )
    return;
  if (
    isDisabledDynamicAgentModel(config, model) ||
    isDisabledDynamicAgentModel(config, `${providerName}/${decodedModel}`)
  )
    return;
  try {
    const route = routeModel(config, model);
    if (route.combo) return;
    const key = `${route.providerName}/${route.modelId}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ provider: route.providerName, model: route.modelId });
  } catch {
    // A stale roster entry must not take the entire dynamic lane down.
  }
}

function dynamicAgentTargets(config: OcxConfig): OcxComboTarget[] {
  const targets: OcxComboTarget[] = [];
  const seen = new Set<string>();

  for (const entry of dynamicAgentRoster(config)) {
    if (targets.length >= 5) break;
    if (typeof entry !== "string") continue;
    const model = entry.trim();
    if (rejectDynamicRosterEntry(config, model)) continue;
    if (model.indexOf("/") < 0) {
      tryAddBareOpenAiTarget(config, model, targets, seen);
      continue;
    }
    tryAddRoutedProviderTarget(config, model, targets, seen);
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
