/**
 * chefvault:// credential resolution for provider auth (PSP-008).
 */
import { ProviderSecurityClient } from "./client";
import { DegradedModeController } from "./degraded";
import {
  CredentialSlotStore,
  globalCredentialSlotStore,
  renewalJitterMs,
  shouldRenewLease,
} from "./slots";
import {
  ProviderSecurityError,
  validateChefVaultRef,
  type CredentialSnapshot,
  type ProviderSecurityErrorCode,
} from "./types";

export interface ResolveCredentialDeps {
  client?: ProviderSecurityClient;
  slotStore?: CredentialSlotStore;
  degraded?: DegradedModeController;
  now?: () => number;
  jitterMs?: number;
}

export interface ResolvedProviderCredential {
  apiKey: string;
  snapshot: CredentialSnapshot;
  source: "chefvault" | "memory";
}

function toProviderSecurityError(error: unknown): ProviderSecurityError {
  if (error instanceof ProviderSecurityError) return error;
  return new ProviderSecurityError(
    "authority_error",
    error instanceof Error ? error.message : "unknown provider-security failure",
  );
}

/**
 * Degraded mode means "ChefVault cannot be reached", so only availability failures may enter it.
 * Any delivered answer proves the authority is reachable: a rejected reference (unknown,
 * invalid, revoked) must keep surfacing its real 401 cause, and `authority_error` (a malformed
 * but delivered response, or a local failure while applying it) must not let a parsing bug
 * masquerade as an outage.
 */
const AUTHORITY_OUTAGE_CODES: ReadonlySet<ProviderSecurityErrorCode> = new Set([
  "authority_unavailable",
  "network_error",
  "auth_not_configured",
]);

export class ProviderCredentialResolver {
  private readonly clientOverride: ProviderSecurityClient | undefined;
  readonly slotStore: CredentialSlotStore;
  private readonly degraded: DegradedModeController;
  private readonly now: () => number;
  private readonly inFlight = new Map<string, Promise<ResolvedProviderCredential>>();

  /**
   * Authority client. The process-wide resolver is constructed at import time, so the endpoint
   * must be read from the environment on use rather than captured at construction.
   */
  get client(): ProviderSecurityClient {
    return this.clientOverride ?? ProviderSecurityClient.fromEnv();
  }

  constructor(deps: ResolveCredentialDeps = {}) {
    this.clientOverride = deps.client;
    this.slotStore = deps.slotStore ?? globalCredentialSlotStore;
    this.degraded = deps.degraded ?? new DegradedModeController(this.slotStore);
    this.now = deps.now ?? (() => Date.now());
  }

  async resolveCredentialRef(ref: string, deps: { jitterMs?: number } = {}): Promise<ResolvedProviderCredential> {
    const invalid = validateChefVaultRef(ref);
    if (invalid) throw invalid;

    const at = this.now();
    const existing = this.slotStore.snapshotForRequest(ref, at);
    if (existing && existing.expiresAt > at) {
      const renewTarget = this.slotStore.getState(ref)?.slots.active;
      if (
        renewTarget &&
        shouldRenewLease(renewTarget, at, deps.jitterMs ?? renewalJitterMs()) &&
        // While degraded, renewal traffic is capped to the same bounded recovery-probe cadence
        // as fresh resolves; between probes the unexpired snapshot keeps serving without
        // touching the authority.
        this.degraded.canResolve(ref, at).allowed
      ) {
        try {
          await this.tryRenew(ref, renewTarget.leaseId, renewTarget.fencingToken, "active");
        } catch (error) {
          // Only a transient authority failure may keep serving the cached snapshot until expiry.
          // An explicit revocation is authoritative: drop the lease and fail the request closed,
          // otherwise a revoked credential keeps authenticating until its old expiry.
          const code = providerSecurityErrorCode(error);
          if (code === "revoked") {
            this.slotStore.revokeRef(ref);
            throw toProviderSecurityError(error);
          }
          // A confirmed authority outage enters degraded mode so later requests in the renewal
          // window stop hammering ChefVault instead of retrying on every resolve.
          if (AUTHORITY_OUTAGE_CODES.has(code)) {
            this.degraded.markUnavailable(ref, at);
          }
        }
        const refreshed = this.slotStore.snapshotForRequest(ref, this.now());
        if (refreshed) {
          return { apiKey: refreshed.secret, snapshot: refreshed, source: "memory" };
        }
      }
      return { apiKey: existing.secret, snapshot: existing, source: "memory" };
    }

    // One resolve per ref at a time. Concurrent cold-start requests would otherwise each mint a
    // lease, and every apply after the first would be rejected as a stale fencing token.
    const pending = this.inFlight.get(ref);
    if (pending) return pending;
    const attempt = this.resolveFromAuthority(ref, at).finally(() => {
      this.inFlight.delete(ref);
    });
    this.inFlight.set(ref, attempt);
    return attempt;
  }

  private async resolveFromAuthority(ref: string, at: number): Promise<ResolvedProviderCredential> {
    // Degraded mode denies new resolution without touching the authority, except for a
    // bounded recovery probe so the gate reopens once ChefVault returns.
    if (!this.degraded.canResolve(ref, at).allowed) {
      throw new ProviderSecurityError(
        "degraded_deny_resolve",
        "ChefVault is unavailable; new credential resolution is denied in degraded mode",
      );
    }
    const state = this.slotStore.getState(ref);
    try {
      const response = await this.client.resolveLease({
        ref,
        ...(state && state.lastFencingToken > 0 ? { fencingToken: state.lastFencingToken } : {}),
      });
      this.degraded.markRecovered(ref);
      const lease = this.slotStore.applyResolve(ref, response, this.now());
      const snapshot = this.slotStore.snapshotForRequest(ref, this.now());
      if (!snapshot) {
        throw new ProviderSecurityError("authority_error", "resolve succeeded but no usable snapshot was stored");
      }
      return { apiKey: lease.secret, snapshot, source: "chefvault" };
    } catch (error) {
      const mapped = toProviderSecurityError(error);
      if (AUTHORITY_OUTAGE_CODES.has(mapped.code)) {
        this.degraded.markUnavailable(ref, at);
      }
      throw mapped;
    }
  }

  private async tryRenew(
    ref: string,
    leaseId: string,
    fencingToken: number,
    phase: "active" | "next" | "retiring",
  ): Promise<void> {
    const response = await this.client.renewLease({ ref, leaseId, fencingToken });
    this.degraded.markRecovered(ref);
    this.slotStore.applyRenew(ref, response, phase, this.now());
  }

  /** Liveness only — `/healthz` is unauthenticated. */
  async probeAuthority(): Promise<{ ok: boolean; message: string }> {
    return this.client.healthz();
  }

  /** Authenticated readiness — bearer token + `/provider-security/status`. */
  async probeAuthenticatedReady(): Promise<{ ok: boolean; message: string }> {
    return this.client.authenticatedReady();
  }
}

export const globalProviderCredentialResolver = new ProviderCredentialResolver();

export async function resolveChefVaultCredential(
  ref: string,
  deps?: ResolveCredentialDeps,
): Promise<ResolvedProviderCredential> {
  return new ProviderCredentialResolver(deps).resolveCredentialRef(ref);
}

export function providerSecurityErrorCode(error: unknown): ProviderSecurityErrorCode {
  if (error instanceof ProviderSecurityError) return error.code;
  return "authority_error";
}
