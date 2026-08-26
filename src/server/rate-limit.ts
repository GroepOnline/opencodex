import type { Server } from "bun";
import { formatErrorResponse } from "../bridge";
import { anthropicErrorResponse } from "../claude/outbound";
import {
  DEFAULT_RATE_LIMIT_WEBSOCKET_CONCURRENCY,
  TokenBucketLimiter,
  WebSocketConcurrencyLimiter,
  type ConcurrencyLimits,
  type ConcurrencyReservation,
  type ConcurrencyStats,
  type RateLimitDecision,
  type RateLimitPolicy,
  type RateLimitPrincipal,
  type RateLimitStatsRow,
  type RateLimitSurface,
} from "../ratelimit";
import type { OcxConfig } from "../types";
import { effectiveBindHostname, isLoopbackHostname } from "./auth-cors";
import { resolveManagementRateLimitPrincipal, type ManagementAuthState } from "./management-auth";
import { resolveDataPlaneRateLimitPrincipal } from "./rate-limit-auth";
import type { WsData } from "./ws-bridge";

/**
 * Fixed per-surface default policies (structure/plugin-metrics-ratelimit-benchmarks.md §3).
 * Values are deliberately generous for a single-operator local proxy: they bound abuse on an
 * exposed bind without throttling ordinary interactive Codex/Claude sessions. Each surface can
 * be overridden through `config.rateLimit.surfaces`.
 */
export const DEFAULT_RATE_LIMIT_SURFACE_POLICIES: Readonly<Record<RateLimitSurface, RateLimitPolicy>> = Object.freeze({
  "management": Object.freeze({ requestsPerMinute: 240, burst: 60 }),
  "responses-http": Object.freeze({ requestsPerMinute: 300, burst: 60 }),
  "responses-websocket": Object.freeze({ requestsPerMinute: 60, burst: 20 }),
  "chat-completions": Object.freeze({ requestsPerMinute: 300, burst: 60 }),
  "claude-messages": Object.freeze({ requestsPerMinute: 300, burst: 60 }),
  "images": Object.freeze({ requestsPerMinute: 60, burst: 10 }),
  "search": Object.freeze({ requestsPerMinute: 120, burst: 30 }),
  "live": Object.freeze({ requestsPerMinute: 60, burst: 10 }),
  "model-discovery": Object.freeze({ requestsPerMinute: 120, burst: 30 }),
});

export { DEFAULT_RATE_LIMIT_WEBSOCKET_CONCURRENCY } from "../ratelimit";

/** Typed aggregate-only snapshot, ready for the metrics lane. Carries no principals. */
export interface RateLimitAggregateSnapshot {
  enabled: boolean;
  requests: readonly RateLimitStatsRow[];
  buckets: Readonly<{ principals: number; overflowSurfaces: number }>;
  websocket: Readonly<{
    globalCount: number;
    trackedPrincipals: number;
    stats: Readonly<ConcurrencyStats>;
  }>;
}

/**
 * Per-request admission gate for one surface.
 *
 * Authentication and Origin checks always retain their existing precedence. `gate()` allocates
 * no limiter state and `preAuthDeny` is kept only as a compatibility seam for the current router;
 * it is always null. `commit()` resolves the already-validated credential domain and consumes one
 * request token only after the caller's existing auth/origin checks passed.
 */
export interface AdmissionGate {
  /** Compatibility seam for current router call sites; auth-first admission never pre-denies. */
  readonly preAuthDeny: null;
  /** Charge the authenticated principal after auth+origin pass. Null = admitted. Idempotent. */
  commit(): Response | null;
  /**
   * Reserve a WebSocket concurrency slot BEFORE the handshake completes. The caller must release
   * on upgrade failure and store the idempotent release handle on socket data for every close path.
   * A Response means the reservation was denied (429).
   */
  reserveConcurrency(): { release(): void } | Response;
}

export interface ServerAdmissionControl {
  readonly enabled: boolean;
  gate(surface: RateLimitSurface, req: Request, requestServer: Server<WsData>): AdmissionGate;
  /** Aggregate-only counters for the metrics lane. Never exposes principals. */
  snapshot(): RateLimitAggregateSnapshot;
  /** Explicit test/shutdown boundary: clears every bucket, reservation, and counter. */
  reset(): void;
}

interface ResolvedRateLimitSettings {
  loopbackBypass: boolean;
  boundLoopback: boolean;
  policies: Record<RateLimitSurface, RateLimitPolicy>;
  websocket: ConcurrencyLimits;
}

function rateLimitHeaders(decision: Pick<RateLimitDecision, "limit" | "remaining" | "retryAfterSeconds" | "resetAfterSeconds">): Record<string, string> {
  return {
    "Retry-After": String(Math.max(1, Math.ceil(decision.retryAfterSeconds))),
    "RateLimit-Limit": String(Math.floor(decision.limit)),
    "RateLimit-Remaining": String(Math.max(0, Math.floor(decision.remaining))),
    "RateLimit-Reset": String(Math.max(0, Math.ceil(decision.resetAfterSeconds))),
  };
}

function withRateLimitHeaders(response: Response, headers: Record<string, string>): Response {
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) merged.set(name, value);
  merged.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers: merged });
}

/**
 * Surface-correct 429 envelope: Anthropic error shape for Claude routes, the management JSON
 * shape for `/api/*`, and the OpenAI error envelope everywhere else. The message never carries
 * principal or fingerprint material.
 */
export function rateLimitedResponse(surface: RateLimitSurface, decision: RateLimitDecision): Response {
  const message = `Rate limit exceeded; retry after ${Math.max(1, Math.ceil(decision.retryAfterSeconds))} seconds`;
  const base = surface === "management"
    ? Response.json({ error: "rate limit exceeded; retry later" }, { status: 429 })
    : surface === "claude-messages"
      ? anthropicErrorResponse(429, message, "rate_limit_error")
      : formatErrorResponse(429, "rate_limit_error", message);
  return withRateLimitHeaders(base, rateLimitHeaders(decision));
}

function concurrencyDeniedResponse(
  limits: ConcurrencyLimits,
  reservation: Extract<ConcurrencyReservation, { accepted: false }>,
): Response {
  const limit = reservation.reason === "global_limit" ? limits.global : limits.perPrincipal;
  const retryAfterSeconds = Math.max(1, Math.ceil(reservation.retryAfterSeconds));
  const base = formatErrorResponse(429, "rate_limit_error", `Too many concurrent WebSocket connections; retry after ${retryAfterSeconds} seconds`);
  return withRateLimitHeaders(base, rateLimitHeaders({
    limit,
    remaining: 0,
    retryAfterSeconds,
    resetAfterSeconds: retryAfterSeconds,
  }));
}

function isLoopbackSocketAddress(address: string | null | undefined): boolean {
  const normalized = address?.trim().toLowerCase();
  if (!normalized) return false;
  return normalized === "::1"
    || normalized.startsWith("127.")
    || normalized.startsWith("::ffff:127.");
}

function trustedRemoteAddress(requestServer: Server<WsData>, req: Request): string | null {
  try {
    return requestServer.requestIP(req)?.address ?? null;
  } catch {
    return null;
  }
}

function resolveSettings(config: OcxConfig): ResolvedRateLimitSettings | null {
  const rateLimit = config.rateLimit;
  if (rateLimit?.enabled !== true) return null;
  const policies = {} as Record<RateLimitSurface, RateLimitPolicy>;
  for (const [surface, fallback] of Object.entries(DEFAULT_RATE_LIMIT_SURFACE_POLICIES) as Array<[RateLimitSurface, RateLimitPolicy]>) {
    const override = rateLimit.surfaces?.[surface];
    policies[surface] = override
      ? { requestsPerMinute: override.requestsPerMinute, burst: override.burst }
      : fallback;
  }
  return {
    loopbackBypass: rateLimit.loopbackBypass === true,
    // The actual bound listener is a trust signal the caller cannot forge: when the proxy only
    // listens on loopback, every accepted socket is loopback even if requestIP is unavailable.
    boundLoopback: isLoopbackHostname(effectiveBindHostname(config)),
    policies,
    websocket: {
      perPrincipal: rateLimit.websocket?.perPrincipal ?? DEFAULT_RATE_LIMIT_WEBSOCKET_CONCURRENCY.perPrincipal,
      global: rateLimit.websocket?.global ?? DEFAULT_RATE_LIMIT_WEBSOCKET_CONCURRENCY.global,
    },
  };
}

const NOOP_GATE: AdmissionGate = Object.freeze({
  preAuthDeny: null,
  commit: () => null,
  reserveConcurrency: () => ({ release() { /* nothing reserved */ } }),
});

/**
 * One admission control per server instance, created in `startServer` and never shared, so
 * repeated `startServer(0)` in tests cannot leak buckets or reservations across isolated
 * server instances. `reset()` is the explicit boundary for tests and shutdown.
 */
export function createServerAdmissionControl(
  config: OcxConfig,
  managementAuth: ManagementAuthState,
): ServerAdmissionControl {
  const settings = resolveSettings(config);
  const tokenLimiter = new TokenBucketLimiter(settings
    ? { maxBuckets: config.rateLimit?.maxBuckets, staleAfterMs: config.rateLimit?.staleAfterMs }
    : {});
  const wsLimiter = new WebSocketConcurrencyLimiter();

  return {
    enabled: settings !== null,
    gate(surface, req, requestServer): AdmissionGate {
      if (!settings) return NOOP_GATE;
      const address = trustedRemoteAddress(requestServer, req);
      // Loopback bypass keys ONLY on the trusted socket address or the bound loopback listener.
      // `Origin` and forwarded headers are caller-controlled and are never consulted here.
      if (settings.loopbackBypass && (settings.boundLoopback || isLoopbackSocketAddress(address))) {
        return NOOP_GATE;
      }

      let principal: RateLimitPrincipal | null = null;
      const authenticatedPrincipal = (): RateLimitPrincipal => {
        if (principal) return principal;
        principal = surface === "management"
          ? resolveManagementRateLimitPrincipal(req, managementAuth, address)
          : resolveDataPlaneRateLimitPrincipal(req, config, address);
        return principal;
      };

      const policy = settings.policies[surface];
      let charged = false;
      return {
        preAuthDeny: null,
        commit: () => {
          if (charged) return null;
          charged = true;
          const decision = tokenLimiter.consume(surface, authenticatedPrincipal(), policy);
          return decision.allowed ? null : rateLimitedResponse(surface, decision);
        },
        reserveConcurrency: () => {
          const reservation = wsLimiter.reserve(authenticatedPrincipal(), settings.websocket);
          if (!reservation.accepted) return concurrencyDeniedResponse(settings.websocket, reservation);
          return { release: reservation.release };
        },
      };
    },
    snapshot(): RateLimitAggregateSnapshot {
      return Object.freeze({
        enabled: settings !== null,
        requests: tokenLimiter.statsSnapshot(),
        buckets: tokenLimiter.bucketCounts(),
        websocket: wsLimiter.snapshot(),
      });
    },
    reset(): void {
      tokenLimiter.reset();
      wsLimiter.reset();
    },
  };
}
