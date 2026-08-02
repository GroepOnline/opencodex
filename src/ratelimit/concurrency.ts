import type { RateLimitPrincipal } from "./principal";

export interface ConcurrencyLimits {
  perPrincipal: number;
  global: number;
}

export interface ConcurrencyLimiterOptions {
  maxTrackedPrincipals?: number;
}

export type ConcurrencyDenyReason = "global_limit" | "principal_limit" | "principal_capacity";

export type ConcurrencyReservation =
  | {
    accepted: true;
    principalCount: number;
    globalCount: number;
    release(): void;
  }
  | {
    accepted: false;
    reason: ConcurrencyDenyReason;
    principalCount: number;
    globalCount: number;
    retryAfterSeconds: number;
  };

export interface ConcurrencyStats {
  accepted: number;
  deniedGlobal: number;
  deniedPrincipal: number;
  deniedPrincipalCapacity: number;
}

function validateLimit(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function increment(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

/**
 * Synchronous reservation gate for long-lived WebSocket connections.
 *
 * The caller reserves before completing the handshake, releases immediately when upgrade fails,
 * and keeps the returned idempotent release function on the socket for all close/error paths.
 */
export class WebSocketConcurrencyLimiter {
  private readonly counts = new Map<string, number>();
  private globalCount = 0;
  private generation = 0;
  private readonly maxTrackedPrincipals: number;
  private stats: ConcurrencyStats = {
    accepted: 0,
    deniedGlobal: 0,
    deniedPrincipal: 0,
    deniedPrincipalCapacity: 0,
  };

  constructor(options: ConcurrencyLimiterOptions = {}) {
    this.maxTrackedPrincipals = validateLimit(
      options.maxTrackedPrincipals ?? 10_000,
      "maxTrackedPrincipals",
    );
  }

  reserve(principal: RateLimitPrincipal, limitsInput: ConcurrencyLimits): ConcurrencyReservation {
    const limits = {
      perPrincipal: validateLimit(limitsInput.perPrincipal, "perPrincipal"),
      global: validateLimit(limitsInput.global, "global"),
    };
    const currentPrincipal = this.counts.get(principal.fingerprint) ?? 0;

    if (this.globalCount >= limits.global) {
      this.stats.deniedGlobal = increment(this.stats.deniedGlobal);
      return Object.freeze({
        accepted: false,
        reason: "global_limit",
        principalCount: currentPrincipal,
        globalCount: this.globalCount,
        retryAfterSeconds: 1,
      });
    }
    if (currentPrincipal >= limits.perPrincipal) {
      this.stats.deniedPrincipal = increment(this.stats.deniedPrincipal);
      return Object.freeze({
        accepted: false,
        reason: "principal_limit",
        principalCount: currentPrincipal,
        globalCount: this.globalCount,
        retryAfterSeconds: 1,
      });
    }
    if (currentPrincipal === 0 && this.counts.size >= this.maxTrackedPrincipals) {
      this.stats.deniedPrincipalCapacity = increment(this.stats.deniedPrincipalCapacity);
      return Object.freeze({
        accepted: false,
        reason: "principal_capacity",
        principalCount: 0,
        globalCount: this.globalCount,
        retryAfterSeconds: 1,
      });
    }

    const nextPrincipal = currentPrincipal + 1;
    this.counts.set(principal.fingerprint, nextPrincipal);
    this.globalCount += 1;
    this.stats.accepted = increment(this.stats.accepted);
    const generation = this.generation;
    let released = false;

    return Object.freeze({
      accepted: true,
      principalCount: nextPrincipal,
      globalCount: this.globalCount,
      release: () => {
        if (released) return;
        released = true;
        if (generation !== this.generation) return;
        const current = this.counts.get(principal.fingerprint) ?? 0;
        if (current <= 1) this.counts.delete(principal.fingerprint);
        else this.counts.set(principal.fingerprint, current - 1);
        this.globalCount = Math.max(0, this.globalCount - 1);
      },
    });
  }

  snapshot(): Readonly<{
    globalCount: number;
    trackedPrincipals: number;
    stats: Readonly<ConcurrencyStats>;
  }> {
    return Object.freeze({
      globalCount: this.globalCount,
      trackedPrincipals: this.counts.size,
      stats: Object.freeze({ ...this.stats }),
    });
  }

  reset(): void {
    this.generation += 1;
    this.counts.clear();
    this.globalCount = 0;
    this.stats = {
      accepted: 0,
      deniedGlobal: 0,
      deniedPrincipal: 0,
      deniedPrincipalCapacity: 0,
    };
  }
}
