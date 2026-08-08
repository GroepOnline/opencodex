/**
 * In-memory credential slot model (PSP-008).
 *
 * Slots: active / next / retiring / revoked. Raw secrets live only in process memory.
 */
import {
  ProviderSecurityError,
  type ChefVaultRenewResponse,
  type ChefVaultResolveResponse,
  type CredentialLease,
  type CredentialSlotPhase,
  type CredentialSnapshot,
  type ProviderSecurityMode,
  type RedactedProviderSecurityStatus,
  type RedactedSlotSummary,
  type SlotStoreState,
} from "./types";

const RENEWAL_LEAD_MS = 5 * 60_000;
const RENEWAL_JITTER_MS = 30_000;

function nowMs(): number {
  return Date.now();
}

function isUsableLease(lease: CredentialLease | undefined, at = nowMs()): lease is CredentialLease {
  return !!lease && lease.phase !== "revoked" && lease.expiresAt > at;
}

function freezeSnapshot(lease: CredentialLease): CredentialSnapshot {
  if (lease.phase === "revoked") {
    throw new Error("revoked leases cannot produce request snapshots");
  }
  return Object.freeze({
    ref: lease.ref,
    leaseId: lease.leaseId,
    secret: lease.secret,
    expiresAt: lease.expiresAt,
    fencingToken: lease.fencingToken,
    phase: lease.phase,
  });
}

function toLease(
  ref: string,
  response: ChefVaultResolveResponse | ChefVaultRenewResponse,
  phase: CredentialSlotPhase,
  resolvedAt = nowMs(),
): CredentialLease {
  return {
    ref,
    leaseId: response.leaseId,
    secret: response.secret,
    expiresAt: response.expiresAt,
    fencingToken: response.fencingToken,
    phase,
    resolvedAt,
  };
}

export function renewalJitterMs(seed = Math.random()): number {
  return Math.floor(seed * RENEWAL_JITTER_MS);
}

export function shouldRenewLease(lease: CredentialLease | undefined, at = nowMs(), jitterMs = 0): boolean {
  if (!isUsableLease(lease, at)) return false;
  return lease.expiresAt - at <= RENEWAL_LEAD_MS + jitterMs;
}

export class CredentialSlotStore {
  private readonly stores = new Map<string, SlotStoreState>();

  private ensure(ref: string): SlotStoreState {
    const existing = this.stores.get(ref);
    if (existing) return existing;
    const created: SlotStoreState = {
      ref,
      mode: "normal",
      lastFencingToken: 0,
      slots: {},
      degradedSince: null,
      lastRenewalAt: null,
    };
    this.stores.set(ref, created);
    return created;
  }

  getState(ref: string): SlotStoreState | undefined {
    const state = this.stores.get(ref);
    if (!state) return undefined;
    return {
      ...state,
      slots: { ...state.slots },
    };
  }

  enterDegraded(ref: string, at = nowMs()): void {
    const state = this.ensure(ref);
    state.mode = "degraded";
    state.degradedSince ??= at;
  }

  exitDegraded(ref: string): void {
    const state = this.stores.get(ref);
    if (!state) return;
    state.mode = "normal";
    state.degradedSince = null;
  }

  getMode(ref: string): ProviderSecurityMode {
    return this.stores.get(ref)?.mode ?? "normal";
  }

  /** Immutable snapshot for an in-flight upstream request. Prefers active, then retiring. */
  snapshotForRequest(ref: string, at = nowMs()): CredentialSnapshot | null {
    const state = this.stores.get(ref);
    if (!state) return null;
    const active = state.slots.active;
    if (isUsableLease(active, at)) return freezeSnapshot(active);
    const retiring = state.slots.retiring;
    if (isUsableLease(retiring, at)) return freezeSnapshot(retiring);
    return null;
  }

  applyResolve(ref: string, response: ChefVaultResolveResponse, at = nowMs()): CredentialLease {
    const state = this.ensure(ref);
    if (response.fencingToken <= state.lastFencingToken) {
      throw new ProviderSecurityError("stale_fencing_token", "fencing token is stale");
    }

    const targetPhase = response.slotHint ?? "active";
    const previousActive = state.slots.active;
    const lease = toLease(ref, response, targetPhase, at);

    if (targetPhase === "active") {
      if (previousActive && previousActive.leaseId !== lease.leaseId) {
        state.slots.retiring = { ...previousActive, phase: "retiring" };
      }
      state.slots.active = lease;
    } else if (targetPhase === "next") {
      state.slots.next = lease;
    } else {
      state.slots.retiring = lease;
    }

    state.lastFencingToken = response.fencingToken;
    state.lastRenewalAt = at;
    return lease;
  }

  applyRenew(ref: string, response: ChefVaultRenewResponse, phase: CredentialSlotPhase, at = nowMs()): CredentialLease {
    const state = this.ensure(ref);
    if (response.fencingToken <= state.lastFencingToken) {
      throw new ProviderSecurityError("stale_fencing_token", "fencing token is stale");
    }
    const lease = toLease(ref, response, phase, at);
    state.slots[phase] = lease;
    state.lastFencingToken = response.fencingToken;
    state.lastRenewalAt = at;
    return lease;
  }

  promoteNextToActive(ref: string, at = nowMs()): CredentialLease | null {
    const state = this.stores.get(ref);
    const next = state?.slots.next;
    if (!state || !isUsableLease(next, at)) return null;
    const previousActive = state.slots.active;
    if (previousActive) {
      state.slots.retiring = { ...previousActive, phase: "retiring" };
    }
    const promoted: CredentialLease = { ...next, phase: "active", resolvedAt: at };
    state.slots.active = promoted;
    delete state.slots.next;
    return promoted;
  }

  revokePhase(ref: string, phase: CredentialSlotPhase): void {
    const state = this.stores.get(ref);
    const lease = state?.slots[phase];
    if (!state || !lease) return;
    state.slots[phase] = { ...lease, phase: "revoked" };
  }

  /**
   * Revocation from the authority is authoritative for the whole ref: no slot (including a
   * retiring lease copied aside during rotation) may keep serving the secret.
   */
  revokeRef(ref: string): void {
    const state = this.stores.get(ref);
    if (!state) return;
    for (const phase of ["active", "next", "retiring"] as const) {
      const lease = state.slots[phase];
      if (lease) state.slots[phase] = { ...lease, phase: "revoked" };
    }
  }

  /** Read-only: reporting on a ref must not create slot state for it. */
  redactedStatus(ref: string, at = nowMs()): RedactedProviderSecurityStatus {
    const state = this.stores.get(ref);
    const slots: RedactedSlotSummary[] = (["active", "next", "retiring", "revoked"] as const).flatMap(phase => {
      const lease = state?.slots[phase];
      if (!lease) return [];
      return [{
        // Report the lease's own phase: a revoked lease stays stored under its slot key,
        // and operators must be able to tell "revoked" apart from "expired".
        phase: lease.phase,
        leaseId: lease.leaseId,
        expiresAt: lease.expiresAt,
        fencingToken: lease.fencingToken,
        valid: isUsableLease(lease, at),
      }];
    });
    return {
      ref,
      mode: state?.mode ?? "normal",
      degradedSince: state?.degradedSince ?? null,
      lastFencingToken: state?.lastFencingToken ?? 0,
      slots,
      hasUsableCredential: slots.some(slot => slot.valid && slot.phase !== "revoked"),
    };
  }
}

/** Process-wide slot store — secrets never leave memory or hit disk. */
export const globalCredentialSlotStore = new CredentialSlotStore();
