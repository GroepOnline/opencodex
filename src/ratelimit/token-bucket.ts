import type { RateLimitPrincipal } from "./principal";

export type RateLimitSurface =
  | "management"
  | "responses-http"
  | "responses-websocket"
  | "chat-completions"
  | "claude-messages"
  | "images"
  | "search"
  | "live"
  | "model-discovery";

export interface RateLimitPolicy {
  requestsPerMinute: number;
  burst: number;
}

export interface TokenBucketLimiterOptions {
  maxBuckets?: number;
  staleAfterMs?: number;
  now?: () => number;
}

export type RateLimitDecision = {
  allowed: boolean;
  surface: RateLimitSurface;
  source: "principal" | "overflow";
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  resetAfterSeconds: number;
  reason: "allowed" | "rate_limited";
};

export interface RateLimitStatsRow {
  surface: RateLimitSurface;
  source: "principal" | "overflow";
  result: "allowed" | "denied";
  count: number;
}

interface BucketState {
  tokens: number;
  updatedAtMs: number;
  lastSeenAtMs: number;
}

const SURFACE_ORDER: readonly RateLimitSurface[] = [
  "management",
  "responses-http",
  "responses-websocket",
  "chat-completions",
  "claude-messages",
  "images",
  "search",
  "live",
  "model-discovery",
];

function validatePositiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be greater than zero`);
  return value;
}

function validatePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

export function validateRateLimitPolicy(policy: RateLimitPolicy): RateLimitPolicy {
  return Object.freeze({
    requestsPerMinute: validatePositiveFinite(policy.requestsPerMinute, "requestsPerMinute"),
    burst: validatePositiveInteger(policy.burst, "burst"),
  });
}

function safeCounterIncrement(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

function statsKey(
  surface: RateLimitSurface,
  source: "principal" | "overflow",
  result: "allowed" | "denied",
): string {
  return `${surface}\0${source}\0${result}`;
}

function bucketKey(surface: RateLimitSurface, principal: RateLimitPrincipal): string {
  return `${surface}\0${principal.fingerprint}`;
}

/**
 * Process-local synchronous token buckets.
 *
 * Consume has no await point: refill, admission, decrement, and persistence happen in one
 * synchronous turn. At the hard principal-bucket cap, a new identity is charged against one
 * shared overflow bucket per bounded surface instead of allocating unbounded state or bypassing
 * protection. Existing principal buckets continue to use their own balance.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, BucketState>();
  private readonly overflowBuckets = new Map<RateLimitSurface, BucketState>();
  private readonly stats = new Map<string, RateLimitStatsRow>();
  private readonly maxBuckets: number;
  private readonly staleAfterMs: number;
  private readonly nowSource: () => number;
  private lastNowMs = 0;

  constructor(options: TokenBucketLimiterOptions = {}) {
    const maxBuckets = options.maxBuckets ?? 10_000;
    const staleAfterMs = options.staleAfterMs ?? 10 * 60_000;
    if (!Number.isInteger(maxBuckets) || maxBuckets < 1) {
      throw new RangeError("maxBuckets must be a positive integer");
    }
    if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
      throw new RangeError("staleAfterMs must be greater than zero");
    }
    this.maxBuckets = maxBuckets;
    this.staleAfterMs = staleAfterMs;
    this.nowSource = options.now ?? (() => performance.now());
  }

  consume(
    surface: RateLimitSurface,
    principal: RateLimitPrincipal,
    policyInput: RateLimitPolicy,
    cost = 1,
  ): RateLimitDecision {
    const policy = validateRateLimitPolicy(policyInput);
    const normalizedCost = validatePositiveFinite(cost, "cost");
    if (normalizedCost > policy.burst) {
      throw new RangeError("cost must not exceed burst");
    }
    const now = this.monotonicNow();
    const key = bucketKey(surface, principal);
    let state = this.buckets.get(key);
    let source: "principal" | "overflow" = "principal";

    if (!state) {
      if (this.buckets.size >= this.maxBuckets) this.evictOneStale(now);
      if (this.buckets.size < this.maxBuckets) {
        state = { tokens: policy.burst, updatedAtMs: now, lastSeenAtMs: now };
        this.buckets.set(key, state);
      } else {
        source = "overflow";
        state = this.overflowBuckets.get(surface);
        if (!state) {
          state = { tokens: policy.burst, updatedAtMs: now, lastSeenAtMs: now };
          this.overflowBuckets.set(surface, state);
        }
      }
    }

    this.refill(state, policy, now);
    state.lastSeenAtMs = now;
    const allowed = state.tokens >= normalizedCost;
    if (allowed) state.tokens -= normalizedCost;

    const refillPerMs = policy.requestsPerMinute / 60_000;
    const deficit = Math.max(0, normalizedCost - state.tokens);
    const retryAfterSeconds = allowed ? 0 : Math.max(1, Math.ceil(deficit / refillPerMs / 1000));
    const resetAfterSeconds = Math.max(0, Math.ceil((policy.burst - state.tokens) / refillPerMs / 1000));
    const decision: RateLimitDecision = {
      allowed,
      surface,
      source,
      limit: policy.burst,
      remaining: Math.max(0, Math.floor(state.tokens)),
      retryAfterSeconds,
      resetAfterSeconds,
      reason: allowed ? "allowed" : "rate_limited",
    };
    this.recordStat(surface, source, allowed ? "allowed" : "denied");
    return decision;
  }

  statsSnapshot(): readonly RateLimitStatsRow[] {
    return Object.freeze([...this.stats.values()]
      .map(row => Object.freeze({ ...row }))
      .sort((left, right) => SURFACE_ORDER.indexOf(left.surface) - SURFACE_ORDER.indexOf(right.surface)
        || left.source.localeCompare(right.source)
        || left.result.localeCompare(right.result)));
  }

  bucketCounts(): Readonly<{ principals: number; overflowSurfaces: number }> {
    return Object.freeze({
      principals: this.buckets.size,
      overflowSurfaces: this.overflowBuckets.size,
    });
  }

  reset(): void {
    this.buckets.clear();
    this.overflowBuckets.clear();
    this.stats.clear();
    this.lastNowMs = 0;
  }

  private monotonicNow(): number {
    const sampled = this.nowSource();
    const finite = Number.isFinite(sampled) ? Math.max(0, sampled) : this.lastNowMs;
    this.lastNowMs = Math.max(this.lastNowMs, finite);
    return this.lastNowMs;
  }

  private refill(state: BucketState, policy: RateLimitPolicy, now: number): void {
    const elapsedMs = Math.max(0, now - state.updatedAtMs);
    const refill = elapsedMs * policy.requestsPerMinute / 60_000;
    state.tokens = Math.min(policy.burst, Math.max(0, state.tokens + refill));
    state.updatedAtMs = now;
  }

  private evictOneStale(now: number): void {
    let candidateKey: string | undefined;
    let candidateLastSeen = Number.POSITIVE_INFINITY;
    for (const [key, state] of this.buckets) {
      if (now - state.lastSeenAtMs < this.staleAfterMs) continue;
      if (state.lastSeenAtMs < candidateLastSeen) {
        candidateKey = key;
        candidateLastSeen = state.lastSeenAtMs;
      }
    }
    if (candidateKey !== undefined) this.buckets.delete(candidateKey);
  }

  private recordStat(
    surface: RateLimitSurface,
    source: "principal" | "overflow",
    result: "allowed" | "denied",
  ): void {
    const key = statsKey(surface, source, result);
    const row = this.stats.get(key) ?? { surface, source, result, count: 0 };
    row.count = safeCounterIncrement(row.count);
    this.stats.set(key, row);
  }
}
