import { listProviderApiKeys, type ProviderApiKeyInfo } from "../providers/api-keys";
import { activeProviderCooldowns } from "../providers/cap-cooldown";
import { clearKeyCooldowns, getKeyCooldownUntil } from "../providers/key-failover";
import type { OcxConfig } from "../types";

export type InspectedApiKey = ProviderApiKeyInfo & { cooldownUntil?: number };

/** Management adapter: drop key-pool cooldowns after the operator edits keys. */
export function clearKeyPoolCooldowns(providerName?: string): void {
  clearKeyCooldowns(providerName);
}

/** Live key-pool view: masked keys plus which ones Availability is currently cooling. */
export function inspectKeyPool(
  config: OcxConfig,
  name: string,
  now = Date.now(),
): { activeId: string | null; keys: InspectedApiKey[] } {
  const listed = listProviderApiKeys(config, name);
  return {
    activeId: listed.activeId,
    keys: listed.keys.map(key => {
      const cooldownUntil = getKeyCooldownUntil(name, key.id, now);
      return cooldownUntil ? { ...key, cooldownUntil } : key;
    }),
  };
}

/** Live routing read-model: pool size, first hop, cooling keys, cap window. No secrets. */
export type AvailabilityProviderView = {
  name: string;
  keyPoolCount: number;
  hopProvider?: string;
  hopModel?: string;
  coolingKeyCount: number;
  capUntil?: number;
  capDisabled?: boolean;
};

export function inspectAvailability(
  config: OcxConfig,
  now = Date.now(),
): { providers: AvailabilityProviderView[] } {
  const caps = activeProviderCooldowns(config, now);
  const providers: AvailabilityProviderView[] = [];
  for (const [name, provider] of Object.entries(config.providers)) {
    const keyPoolCount = provider.apiKeyPool?.length
      ?? ((provider.apiKey || provider.credentialRef) ? 1 : 0);
    const hop = provider.fallback?.[0];
    const coolingKeyCount = (provider.apiKeyPool?.length ?? 0) >= 2
      ? inspectKeyPool(config, name, now).keys.filter(
        key => typeof key.cooldownUntil === "number" && key.cooldownUntil > now,
      ).length
      : 0;
    const cap = caps[name];
    providers.push({
      name,
      keyPoolCount,
      coolingKeyCount,
      ...(hop?.provider ? { hopProvider: hop.provider, hopModel: hop.model } : {}),
      ...(cap ? { capUntil: cap.until, capDisabled: cap.disabledProvider === true } : {}),
    });
  }
  return { providers };
}
