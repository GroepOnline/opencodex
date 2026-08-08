import type { RateLimitSurface } from "./index";

/**
 * Rate-limit configuration augments the canonical config module without forcing the large shared
 * types file to own runtime-admission implementation details.
 */
declare module "../types" {
  /** Fixed request-rate policy for one admission surface. */
  export interface OcxRateLimitSurfacePolicy {
    /** Sustained refill rate. Must be a positive finite number. */
    requestsPerMinute: number;
    /** Bucket capacity (max burst). Must be a positive integer. */
    burst: number;
  }

  /** Optional admission-aware rate limiting. Absent or disabled preserves historical behavior. */
  export interface OcxRateLimitConfig {
    enabled: boolean;
    /** Trusted socket/bind based loopback exemption. Origin and forwarded headers never qualify. */
    loopbackBypass?: boolean;
    /** Hard cap on tracked principal buckets before bounded overflow accounting. */
    maxBuckets?: number;
    /** Idle milliseconds before a principal bucket may be evicted at the hard cap. */
    staleAfterMs?: number;
    /** Per-surface policy overrides; omitted surfaces use built-in defaults. */
    surfaces?: Partial<Record<RateLimitSurface, OcxRateLimitSurfacePolicy>>;
    /** Responses WebSocket concurrent-connection limits. */
    websocket?: {
      perPrincipal?: number;
      global?: number;
    };
  }

  export interface OcxConfig {
    /** Optional admission-aware rate limiting. Default disabled. */
    rateLimit?: OcxRateLimitConfig;
  }
}

export {};
