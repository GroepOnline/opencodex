import type { OcxConfig, OcxProviderConfig } from "../types";
import { parseRetryAfterMs } from "../combos";

const DEFAULT_PROVIDER_COOLDOWN_MS = 60_000;
const MAX_PROVIDER_COOLDOWN_MS = 10 * 60_000;
// Keep an expired family long enough to serialize a recovery canary, then forget
// dormant history so provider churn cannot grow process state forever.
const PROVIDER_COOLDOWN_RETENTION_MS = MAX_PROVIDER_COOLDOWN_MS;
const MAX_DORMANT_PROVIDER_COOLDOWNS = 1_024;

type ProviderCooldown = {
  until: number;
  recoveryLease?: {
    id: symbol;
    until: number;
  };
};

export type ProviderFamilyRecoveryLease = {
  family: string;
  id: symbol;
};

export type ProviderFamilyAdmission =
  | { allowed: false }
  | { allowed: true; recoveryLease?: ProviderFamilyRecoveryLease };

const RECOVERY_LEASE_MS = 30_000;
const cooldowns = new Map<string, ProviderCooldown>();

function pruneProviderFamilyCooldowns(now: number): void {
  for (const [family, cooldown] of cooldowns) {
    const leaseUntil = cooldown.recoveryLease?.until ?? 0;
    if (
      cooldown.until + PROVIDER_COOLDOWN_RETENTION_MS <= now
      && leaseUntil <= now
    ) cooldowns.delete(family);
  }
  if (cooldowns.size <= MAX_DORMANT_PROVIDER_COOLDOWNS) return;

  const dormant = [...cooldowns.entries()]
    .filter(([, cooldown]) =>
      cooldown.until <= now && (cooldown.recoveryLease?.until ?? 0) <= now)
    .sort((a, b) => a[1].until - b[1].until);
  for (const [family] of dormant) {
    if (cooldowns.size <= MAX_DORMANT_PROVIDER_COOLDOWNS) break;
    cooldowns.delete(family);
  }
}

/**
 * Azure capacity is shared across sibling deployments more often than a combo
 * target suggests. Treat one 429 as provider-family backpressure so another
 * generated-agent dispatch cannot immediately probe a sibling Azure route.
 */
export function providerCooldownFamily(
  providerName: string,
  provider: Pick<OcxProviderConfig, "adapter" | "baseUrl"> | undefined,
): string | null {
  const name = providerName.toLowerCase();
  const host = (() => {
    try { return new URL(provider?.baseUrl ?? "").hostname.toLowerCase(); }
    catch { return ""; }
  })();
  const azure = provider?.adapter === "azure-openai"
    || name.includes("azure")
    || host.endsWith(".azure.com")
    || host.endsWith(".azure.net")
    || host.endsWith(".openai.azure.com");
  if (!azure) return null;
  // Azure quotas are shared across deployments on one resource, not across every
  // Azure resource in this process. The normalized origin is the narrowest stable
  // boundary available in provider config; fall back to the provider row only when
  // a malformed or missing URL prevents deriving that resource identity.
  return host ? `azure:${host}` : `azure-provider:${name}`;
}

export function coolProviderFamilyAfter429(
  config: OcxConfig,
  providerName: string,
  retryAfter: string | null | undefined,
  now = Date.now(),
): void {
  const family = providerCooldownFamily(providerName, config.providers[providerName]);
  if (!family) return;
  pruneProviderFamilyCooldowns(now);
  const duration = parseRetryAfterMs(retryAfter, now) ?? DEFAULT_PROVIDER_COOLDOWN_MS;
  const until = now + Math.min(Math.max(duration, 1), MAX_PROVIDER_COOLDOWN_MS);
  const previous = cooldowns.get(family);
  if (!previous || previous.until < until) cooldowns.set(family, { until });
}

export function acquireProviderFamilyAdmission(
  config: OcxConfig,
  providerName: string,
  now = Date.now(),
): ProviderFamilyAdmission {
  const family = providerCooldownFamily(providerName, config.providers[providerName]);
  if (!family) return { allowed: true };
  const cooldown = cooldowns.get(family);
  if (!cooldown) return { allowed: true };
  if (cooldown.until > now) return { allowed: false };
  if (cooldown.recoveryLease && cooldown.recoveryLease.until > now) {
    return { allowed: false };
  }

  const id = Symbol(family);
  cooldown.recoveryLease = { id, until: now + RECOVERY_LEASE_MS };
  return { allowed: true, recoveryLease: { family, id } };
}

export function isProviderFamilyCooling(
  config: OcxConfig,
  providerName: string,
  now = Date.now(),
): boolean {
  const family = providerCooldownFamily(providerName, config.providers[providerName]);
  if (!family) return false;
  const cooldown = cooldowns.get(family);
  if (!cooldown) return false;
  return cooldown.until > now
    || (cooldown.recoveryLease?.until ?? 0) > now;
}

export function settleProviderFamilyRecovery(
  lease: ProviderFamilyRecoveryLease | undefined,
  success: boolean,
): void {
  if (!lease) return;
  const cooldown = cooldowns.get(lease.family);
  if (!cooldown || cooldown.recoveryLease?.id !== lease.id) return;
  if (success) cooldowns.delete(lease.family);
  else delete cooldown.recoveryLease;
}

export function providerFamilyCooldownCountForTests(): number {
  return cooldowns.size;
}

export function clearProviderFamilyCooldownsForTests(): void {
  cooldowns.clear();
}
