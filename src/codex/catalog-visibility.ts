/**
 * Opt-in client picker / `/v1/models` hiding for provider-level death.
 *
 * Admin surfaces keep the full last-good catalog plus an explicit reason. Client listings and the
 * Codex new-session picker filter only when `hideUnavailableModels` is enabled. Routing is
 * untouched: active and recent-affinity sessions keep calling the last-good catalog.
 *
 * Hide triggers (provider-level only — never a single-account cooldown):
 * - provider `disabled: true` (already excluded from gather; reason still reported)
 * - every OAuth account marked `needsReauth`
 * - N consecutive live discovery failures (grace = N-1 transient fails still visible)
 */
import { getAccountSet } from "../oauth/store";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { getDiscoveryFailStreak } from "./model-cache";
import type { CatalogModel } from "./catalog/parsing";

/** Default consecutive discovery failures before client hide (when the flag is on). */
export const DEFAULT_HIDE_AFTER_DISCOVERY_FAILS = 3;

export type ProviderClientHideReason =
  | "disabled"
  | "all_accounts_reauth"
  | "discovery_failed";

export function hideUnavailableModelsEnabled(
  config: Pick<OcxConfig, "hideUnavailableModels">,
): boolean {
  return config.hideUnavailableModels === true;
}

export function hideUnavailableAfterDiscoveryFails(
  config: Pick<OcxConfig, "hideUnavailableAfterDiscoveryFails">,
): number {
  const raw = config.hideUnavailableAfterDiscoveryFails;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1) {
    return Math.floor(raw);
  }
  return DEFAULT_HIDE_AFTER_DISCOVERY_FAILS;
}

/** True when every stored OAuth account for the provider needs re-login. Empty store is not death. */
export function allOAuthAccountsNeedReauth(
  providerName: string,
  prov: Pick<OcxProviderConfig, "authMode"> | undefined,
): boolean {
  if (prov?.authMode !== "oauth") return false;
  const set = getAccountSet(providerName);
  if (!set || set.accounts.length === 0) return false;
  return set.accounts.every(account => account.needsReauth === true);
}

/**
 * Provider-level death reason for admin display. Independent of `hideUnavailableModels` so the
 * Models tab can always show why a provider is unhealthy. Returns null while the provider is fine
 * or only partially degraded (e.g. one account cooling down).
 */
export function providerClientHideReason(
  providerName: string,
  config: Pick<OcxConfig, "providers" | "hideUnavailableAfterDiscoveryFails">,
): ProviderClientHideReason | null {
  const prov = config.providers[providerName];
  if (!prov) return null;
  if (prov.disabled === true) return "disabled";
  if (allOAuthAccountsNeedReauth(providerName, prov)) return "all_accounts_reauth";
  const streak = getDiscoveryFailStreak(providerName);
  if (streak >= hideUnavailableAfterDiscoveryFails(config)) return "discovery_failed";
  return null;
}

/** Whether client `/v1/models` and new-session pickers should omit this provider's models. */
export function shouldHideProviderFromClients(
  providerName: string,
  config: Pick<OcxConfig, "providers" | "hideUnavailableModels" | "hideUnavailableAfterDiscoveryFails">,
): boolean {
  if (!hideUnavailableModelsEnabled(config)) return false;
  return providerClientHideReason(providerName, config) !== null;
}

/**
 * Filter last-good catalog rows from client-facing lists when hide is enabled and the provider is
 * dead. Admin callers must not use this — they keep the full catalog via {@link providerClientHideReason}.
 */
export function filterClientCatalogModels(
  models: CatalogModel[],
  config: Pick<OcxConfig, "providers" | "hideUnavailableModels" | "hideUnavailableAfterDiscoveryFails">,
): CatalogModel[] {
  if (!hideUnavailableModelsEnabled(config)) return models;
  const hidden = new Set<string>();
  for (const name of Object.keys(config.providers)) {
    if (shouldHideProviderFromClients(name, config)) hidden.add(name);
  }
  if (hidden.size === 0) return models;
  return models.filter(model => !hidden.has(model.provider));
}

export function clientHideReasonLabel(reason: ProviderClientHideReason): string {
  switch (reason) {
    case "disabled":
      return "Provider is disabled";
    case "all_accounts_reauth":
      return "All accounts require re-authentication";
    case "discovery_failed":
      return "Model discovery failed repeatedly";
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}
