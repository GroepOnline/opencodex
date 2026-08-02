/**
 * Bounded degraded mode when ChefVault is unavailable (PSP-011 stub).
 *
 * - Existing valid in-memory credentials may still be used (bounded by lease expiry).
 * - New resolution against the authority is denied until recovery.
 */
import { CredentialSlotStore } from "./slots";

export interface DegradedDecision {
  allowed: boolean;
  reason?: "degraded_deny_resolve" | "lease_expired" | "revoked" | "missing";
}

const RECOVERY_PROBE_INTERVAL_MS = 30_000;

export class DegradedModeController {
  /** Last time the authority was probed (and failed) for a ref. */
  private readonly lastAttemptAt = new Map<string, number>();
  private readonly probeIntervalMs: number;

  constructor(
    private readonly store: CredentialSlotStore,
    probeIntervalMs = RECOVERY_PROBE_INTERVAL_MS,
  ) {
    this.probeIntervalMs = probeIntervalMs;
  }

  markUnavailable(ref: string, at = Date.now()): void {
    this.store.enterDegraded(ref, at);
    this.lastAttemptAt.set(ref, at);
  }

  markRecovered(ref: string): void {
    this.store.exitDegraded(ref);
    this.lastAttemptAt.delete(ref);
  }

  isDegraded(ref: string): boolean {
    return this.store.getMode(ref) === "degraded";
  }

  /**
   * Whether a fresh resolve against ChefVault is permitted. While degraded, new resolution
   * is denied except for a bounded recovery probe once per probe interval, so the gate can
   * reopen without waiting for a successful renewal.
   */
  canResolve(ref: string, at = Date.now()): DegradedDecision {
    if (!this.isDegraded(ref)) {
      return { allowed: true };
    }
    const lastAttempt = this.lastAttemptAt.get(ref) ?? 0;
    if (at - lastAttempt >= this.probeIntervalMs) {
      return { allowed: true };
    }
    return { allowed: false, reason: "degraded_deny_resolve" };
  }

  /** Whether an already-resolved in-memory credential may be used for upstream auth. */
  canUseExisting(ref: string, at = Date.now()): DegradedDecision {
    const snapshot = this.store.snapshotForRequest(ref, at);
    if (!snapshot) {
      if (this.isDegraded(ref)) {
        return { allowed: false, reason: "degraded_deny_resolve" };
      }
      return { allowed: false, reason: "missing" };
    }
    if (snapshot.expiresAt <= at) {
      return { allowed: false, reason: "lease_expired" };
    }
    return { allowed: true };
  }
}
