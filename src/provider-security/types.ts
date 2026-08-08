/** ChefVault provider-security plane — shared types and error taxonomy (PSP-008). */

export const CHEFVAULT_REF_PREFIX = "chefvault://";

export type CredentialSlotPhase = "active" | "next" | "retiring" | "revoked";

export type ProviderSecurityMode = "normal" | "degraded";

/** Stable error codes surfaced to callers and doctor/status. */
export type ProviderSecurityErrorCode =
  | "authority_unavailable"
  | "stale_fencing_token"
  | "ref_invalid"
  | "ref_not_found"
  | "lease_expired"
  | "degraded_deny_resolve"
  | "revoked"
  | "network_error"
  | "authority_error"
  | "auth_required"
  | "auth_invalid"
  | "auth_forbidden"
  | "identity_assertion_mismatch"
  | "auth_not_configured";

export class ProviderSecurityError extends Error {
  readonly code: ProviderSecurityErrorCode;

  constructor(code: ProviderSecurityErrorCode, message: string) {
    super(message);
    this.name = "ProviderSecurityError";
    this.code = code;
  }
}

export interface WorkloadIdentity {
  workloadId: string;
  hostId: string;
  actor: string;
}

export interface ChefVaultResolveRequest {
  ref: string;
  fencingToken?: number;
}

export interface ChefVaultResolveResponse {
  leaseId: string;
  secret: string;
  expiresAt: number;
  fencingToken: number;
  slotHint?: Exclude<CredentialSlotPhase, "revoked">;
}

export interface ChefVaultRenewRequest {
  ref: string;
  leaseId: string;
  fencingToken: number;
}

export interface ChefVaultRenewResponse {
  leaseId: string;
  secret: string;
  expiresAt: number;
  fencingToken: number;
}

/** In-memory lease material — never persisted to disk. */
export interface CredentialLease {
  ref: string;
  leaseId: string;
  secret: string;
  expiresAt: number;
  fencingToken: number;
  phase: CredentialSlotPhase;
  resolvedAt: number;
}

/** Immutable credential view handed to a single upstream request. */
export interface CredentialSnapshot {
  readonly ref: string;
  readonly leaseId: string;
  readonly secret: string;
  readonly expiresAt: number;
  readonly fencingToken: number;
  readonly phase: Exclude<CredentialSlotPhase, "revoked">;
}

export interface SlotStoreState {
  ref: string;
  mode: ProviderSecurityMode;
  lastFencingToken: number;
  slots: Partial<Record<CredentialSlotPhase, CredentialLease>>;
  degradedSince: number | null;
  lastRenewalAt: number | null;
}

/** Redacted slot summary safe for doctor/status/telemetry. */
export interface RedactedSlotSummary {
  phase: CredentialSlotPhase;
  leaseId: string;
  expiresAt: number;
  fencingToken: number;
  valid: boolean;
}

export interface RedactedProviderSecurityStatus {
  ref: string;
  mode: ProviderSecurityMode;
  degradedSince: number | null;
  lastFencingToken: number;
  slots: RedactedSlotSummary[];
  hasUsableCredential: boolean;
}

export interface ProviderSecurityClientConfig {
  baseUrl: string;
  workload: WorkloadIdentity;
  /** Bearer token for protected ChefVault routes (`CHEF_PROVIDER_SECURITY_TOKEN`). */
  token?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

export function isChefVaultRef(value: string | undefined): value is string {
  return typeof value === "string" && value.startsWith(CHEFVAULT_REF_PREFIX) && value.length > CHEFVAULT_REF_PREFIX.length;
}

export function validateChefVaultRef(ref: string): ProviderSecurityError | null {
  if (!isChefVaultRef(ref)) {
    return new ProviderSecurityError("ref_invalid", `credential ref must start with ${CHEFVAULT_REF_PREFIX}`);
  }
  // The raw ref string is the authority lookup key, so validate it verbatim: URL parsing
  // would normalize away traversal segments and percent-encode whitespace.
  if (/[\s\u0000-\u001f\u007f]/.test(ref)) {
    return new ProviderSecurityError("ref_invalid", "credential ref must not contain whitespace or control characters");
  }
  // Host-only refs (chefvault://name) are accepted, matching isChefVaultRef.
  const segments = ref.slice(CHEFVAULT_REF_PREFIX.length).split("/");
  if (segments.some(segment => segment === "" || segment === "." || segment === "..")) {
    return new ProviderSecurityError("ref_invalid", "credential ref must use non-empty path segments without traversal");
  }
  return null;
}

/**
 * Scrub credential material from authority error text before it reaches doctor/status
 * output. Authority responses and transport errors may echo header or token fragments;
 * redact anything shaped like bearer/token material rather than trusting the source.
 */
export function redactProviderSecurityDetail(text: string): string {
  return text
    .replace(/\bbearer\s+[^\s"',;]+/gi, "Bearer [redacted]")
    .replace(/\b(authorization|x-api-key|api[-_]?key|token|secret)(\s*[:=]\s*)[^\s"',;]+/gi, "$1$2[redacted]");
}
