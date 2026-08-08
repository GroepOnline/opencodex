/**
 * Redacted provider-security status for doctor/status surfaces (PSP-008).
 */
import type { OcxConfig, OcxProviderConfig } from "../types";
import { ProviderSecurityClient } from "./client";
import { globalCredentialSlotStore } from "./slots";
import { ProviderCredentialResolver } from "./resolve";
import { redactProviderSecurityDetail, type RedactedProviderSecurityStatus } from "./types";

export interface ProviderSecurityDoctorCheck {
  level: "OK" | "WARN";
  provider: string;
  /** liveness | authenticated | credential | provider */
  layer?: "liveness" | "authenticated" | "credential" | "provider";
  message: string;
}

export interface ProviderSecurityStatusReport {
  authority: {
    ok: boolean;
    url: string;
    message: string;
    livenessOk?: boolean;
    authenticatedOk?: boolean;
  };
  providers: Array<{
    provider: string;
    credentialRef: string;
    status: RedactedProviderSecurityStatus;
  }>;
}

/**
 * Providers that delegate their secret to the plane. Malformed references are included on
 * purpose: a typo'd ref fails every request closed, so hiding it from doctor/status is the worst
 * possible place for it to be invisible.
 */
export function listChefVaultProviders(config: OcxConfig): Array<{ name: string; ref: string; provider: OcxProviderConfig }> {
  return Object.entries(config.providers).flatMap(([name, provider]) => {
    const ref = provider.credentialRef?.trim();
    if (!ref) return [];
    return [{ name, ref, provider }];
  });
}

export function collectProviderSecurityStatus(
  config: OcxConfig,
  client: ProviderSecurityClient = ProviderSecurityClient.fromEnv(),
  slotStore: typeof globalCredentialSlotStore = globalCredentialSlotStore,
): ProviderSecurityStatusReport {
  const authority = client.baseUrl;
  return {
    authority: { ok: false, url: authority, message: "not probed" },
    providers: listChefVaultProviders(config).map(entry => ({
      provider: entry.name,
      credentialRef: entry.ref,
      status: slotStore.redactedStatus(entry.ref),
    })),
  };
}

/**
 * Liveness plus authenticated readiness, for status surfaces. `/healthz` alone can report green
 * while every lease call is rejected, so `authority.ok` requires both probes. Nothing here
 * resolves a credential: reporting status must not mint leases as a side effect, and a proxy
 * with no reference-backed provider must not reach out to the authority at all.
 */
export async function collectProviderSecurityStatusAsync(
  config: OcxConfig,
  resolver: ProviderCredentialResolver = new ProviderCredentialResolver(),
): Promise<ProviderSecurityStatusReport> {
  const base = collectProviderSecurityStatus(config, resolver.client, resolver.slotStore);
  if (base.providers.length === 0) {
    base.authority.message = "not probed (no provider uses a credential reference)";
    return base;
  }

  const liveness = await resolver.probeAuthority();
  const authenticated = liveness.ok
    ? await resolver.probeAuthenticatedReady()
    : { ok: false, message: "skipped (liveness failed)" };
  base.authority = {
    ok: liveness.ok && authenticated.ok,
    url: resolver.client.baseUrl,
    message: redactProviderSecurityDetail(liveness.ok ? authenticated.message : liveness.message),
    livenessOk: liveness.ok,
    authenticatedOk: authenticated.ok,
  };
  return base;
}

export async function collectProviderSecurityDoctorChecks(
  config: OcxConfig,
  resolver: ProviderCredentialResolver = new ProviderCredentialResolver(),
): Promise<ProviderSecurityDoctorCheck[]> {
  const checks: ProviderSecurityDoctorCheck[] = [];
  const refs = listChefVaultProviders(config);

  // A proxy with no reference-backed provider must not reach out to the authority at all:
  // guard before any liveness/authenticated probe, not after.
  if (refs.length === 0) {
    checks.push({
      level: "OK",
      provider: "*",
      layer: "provider",
      message: "No providers configured with chefvault:// credentialRef.",
    });
    return checks;
  }

  const liveness = await resolver.client.healthz();
  if (liveness.ok) {
    checks.push({
      level: "OK",
      provider: "*",
      layer: "liveness",
      message: `Liveness OK: ChefVault /healthz reachable (${resolver.client.baseUrl}).`,
    });
  } else {
    checks.push({
      level: "WARN",
      provider: "*",
      layer: "liveness",
      message: `Liveness FAIL: ChefVault /healthz unavailable (${redactProviderSecurityDetail(liveness.message)}). Degraded mode: existing in-memory leases only; new resolve denied.`,
    });
  }

  if (liveness.ok) {
    const authenticated = await resolver.client.authenticatedReady();
    if (authenticated.ok) {
      checks.push({
        level: "OK",
        provider: "*",
        layer: "authenticated",
        message: "Authenticated readiness OK: Bearer accepted on protected status route.",
      });
    } else {
      checks.push({
        level: "WARN",
        provider: "*",
        layer: "authenticated",
        message: `Authenticated readiness FAIL: ${redactProviderSecurityDetail(authenticated.message)}. Set CHEF_PROVIDER_SECURITY_TOKEN to the workload bearer registered in ChefVault.`,
      });
    }

    if (authenticated.ok && refs.length > 0) {
      let credentialOk = 0;
      for (const { name, ref } of refs) {
        try {
          await resolver.resolveCredentialRef(ref);
          credentialOk += 1;
          checks.push({
            level: "OK",
            provider: name,
            layer: "credential",
            message: `Credential resolve OK for "${name}" (${ref}).`,
          });
        } catch (error) {
          const detail = redactProviderSecurityDetail(error instanceof Error ? error.message : String(error));
          checks.push({
            level: "WARN",
            provider: name,
            layer: "credential",
            message: `Credential resolve/renew FAIL for "${name}" (${ref}): ${detail}`,
          });
        }
      }
      if (credentialOk === refs.length) {
        checks.push({
          level: "OK",
          provider: "*",
          layer: "credential",
          message: `Credential readiness OK: resolved ${credentialOk}/${refs.length} chefvault:// refs.`,
        });
      }
    } else if (!authenticated.ok && refs.length > 0) {
      checks.push({
        level: "WARN",
        provider: "*",
        layer: "credential",
        message: `Credential readiness skipped: ${refs.length} chefvault:// ref(s) configured but authenticated readiness failed.`,
      });
    }
  }

  for (const { name, ref } of refs) {
    const status = resolver.slotStore.redactedStatus(ref);
    if (status.mode === "degraded") {
      checks.push({
        level: "WARN",
        provider: name,
        layer: "provider",
        message: `Provider "${name}" is in degraded mode for ${ref}; only bounded in-memory credentials may be used.`,
      });
      continue;
    }
    if (status.hasUsableCredential) {
      checks.push({
        level: "OK",
        provider: name,
        layer: "provider",
        message: `Provider "${name}" has a usable in-memory lease for ${ref}.`,
      });
    }
  }

  return checks;
}

export function serializeProviderSecurityStatus(report: ProviderSecurityStatusReport): string {
  return JSON.stringify(report);
}
