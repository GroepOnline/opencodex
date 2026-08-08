/**
 * Per-request provider credential resolution.
 *
 * A provider may carry its secret either inline (`apiKey`, possibly an `$ENV` reference) or as a
 * `chefvault://` reference (`credentialRef`) that is leased from the provider-security plane.
 * Every outbound path that authenticates with a provider key must go through here: resolving the
 * reference only in one place (model discovery) leaves ordinary forwarding unauthenticated.
 *
 * The resolved secret is returned for the lifetime of the current request only. It is never
 * written back into the persisted config — callers apply it to a per-request provider copy.
 */
import { resolveEnvValue } from "../config";
import {
  globalProviderCredentialResolver,
  providerSecurityErrorCode,
  ProviderSecurityError,
  redactProviderSecurityDetail,
} from "../provider-security";
import type { OcxProviderConfig } from "../types";

/**
 * The provider's credential reference, or undefined when it authenticates with a plain key.
 *
 * A configured-but-malformed reference is deliberately returned rather than ignored: silently
 * falling back to an absent `apiKey` would forward the request with no Authorization header at
 * all. Resolution rejects it as `ref_invalid` instead, so a typo fails closed and is visible.
 */
export function providerCredentialRef(provider: Pick<OcxProviderConfig, "credentialRef">): string | undefined {
  return provider.credentialRef?.trim() || undefined;
}

/**
 * Effective API key for this request: a leased ChefVault secret when the provider is
 * reference-backed, otherwise the configured (env-expanded) key. Throws
 * `ProviderSecurityError` when a reference cannot be leased, so callers fail closed instead of
 * forwarding an unauthenticated request.
 */
export async function resolveProviderApiKey(provider: OcxProviderConfig): Promise<string | undefined> {
  const ref = providerCredentialRef(provider);
  if (!ref) return resolveEnvValue(provider.apiKey)?.trim() || undefined;
  const resolved = await globalProviderCredentialResolver.resolveCredentialRef(ref);
  return resolved.apiKey;
}

/**
 * Provider copy whose `apiKey` holds the leased secret. Returns the input untouched for
 * providers without a `chefvault://` reference so non-ChefVault routing is unaffected.
 */
export async function withResolvedProviderCredential(provider: OcxProviderConfig): Promise<OcxProviderConfig> {
  const ref = providerCredentialRef(provider);
  if (!ref) return provider;
  const resolved = await globalProviderCredentialResolver.resolveCredentialRef(ref);
  return { ...provider, apiKey: resolved.apiKey };
}

export interface ProviderCredentialFailure {
  status: number;
  type: string;
  message: string;
}

/**
 * HTTP shape for a failed lease. A rejected or unknown reference is a credential problem (401);
 * an unreachable/degraded authority is a temporary upstream condition (503).
 */
export function providerCredentialFailure(providerName: string, error: unknown): ProviderCredentialFailure {
  const code = providerSecurityErrorCode(error);
  // Authority error text may echo header or token fragments; this message reaches data-plane
  // clients through Responses/compact/Images error bodies, so scrub it like doctor/status output.
  const detail = redactProviderSecurityDetail(error instanceof Error ? error.message : String(error));
  const denied = code === "ref_invalid" || code === "ref_not_found" || code === "revoked" || code === "lease_expired";
  return {
    status: denied ? 401 : 503,
    type: denied ? "authentication_error" : "api_error",
    message: `Provider '${providerName}' credential could not be resolved (${code}): ${detail}`,
  };
}

/** Same as `resolveProviderApiKey`, but a failed lease yields undefined instead of throwing. */
export async function tryResolveProviderApiKey(provider: OcxProviderConfig): Promise<string | undefined> {
  try {
    return await resolveProviderApiKey(provider);
  } catch (error) {
    if (error instanceof ProviderSecurityError) return undefined;
    throw error;
  }
}
