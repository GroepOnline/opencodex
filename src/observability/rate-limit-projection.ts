import { RATE_LIMIT_SURFACES, type RateLimitStatsRow, type RateLimitSurface } from "../ratelimit";
import type { RateLimitAggregateSnapshot } from "../server/rate-limit";

export type RateLimitMetricSource = "principal" | "overflow";
export type RateLimitMetricResult = "allowed" | "denied";
export type RateLimitWebSocketMetricReason =
  | "accepted"
  | "global_limit"
  | "principal_limit"
  | "principal_capacity";

export interface RateLimitMetricsSnapshot {
  enabled: true;
  requests: Array<{
    surface: RateLimitSurface;
    source: RateLimitMetricSource;
    result: RateLimitMetricResult;
    count: number;
  }>;
  buckets: {
    principals: number;
    overflowSurfaces: number;
  };
  websocket: {
    currentGlobal: number;
    trackedPrincipals: number;
    reservations: Array<{
      reason: RateLimitWebSocketMetricReason;
      count: number;
    }>;
  };
}

const SURFACE_ORDER: readonly RateLimitSurface[] = RATE_LIMIT_SURFACES;
const SOURCE_ORDER: readonly RateLimitMetricSource[] = ["principal", "overflow"];
const RESULT_ORDER: readonly RateLimitMetricResult[] = ["allowed", "denied"];
const WS_REASON_ORDER: readonly RateLimitWebSocketMetricReason[] = [
  "accepted",
  "global_limit",
  "principal_limit",
  "principal_capacity",
];

function boundedCounter(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(value)));
}

function isSurface(value: unknown): value is RateLimitSurface {
  return typeof value === "string" && (SURFACE_ORDER as readonly string[]).includes(value);
}

function isSource(value: unknown): value is RateLimitMetricSource {
  return value === "principal" || value === "overflow";
}

function isResult(value: unknown): value is RateLimitMetricResult {
  return value === "allowed" || value === "denied";
}

function normalizedRequests(rows: readonly RateLimitStatsRow[]): RateLimitMetricsSnapshot["requests"] {
  return rows
    .filter(row => isSurface(row.surface) && isSource(row.source) && isResult(row.result))
    .map(row => ({
      surface: row.surface,
      source: row.source,
      result: row.result,
      count: boundedCounter(row.count),
    }))
    .sort((left, right) => SURFACE_ORDER.indexOf(left.surface) - SURFACE_ORDER.indexOf(right.surface)
      || SOURCE_ORDER.indexOf(left.source) - SOURCE_ORDER.indexOf(right.source)
      || RESULT_ORDER.indexOf(left.result) - RESULT_ORDER.indexOf(right.result));
}

/**
 * Copy one aggregate-only admission snapshot into the metrics DTO.
 *
 * The input type cannot carry principals, fingerprints, credentials, addresses, Origins, routes,
 * providers, models, requests, conversations, prompts or errors. Values are copied, clamped and
 * sorted so callers cannot mutate limiter state through a metrics response.
 */
export function projectRateLimitMetrics(
  input: Readonly<RateLimitAggregateSnapshot> | null | undefined,
): RateLimitMetricsSnapshot | null {
  if (input?.enabled !== true) return null;
  const stats = input.websocket.stats;
  const reservations: RateLimitMetricsSnapshot["websocket"]["reservations"] = [
    { reason: "accepted", count: boundedCounter(stats.accepted) },
    { reason: "global_limit", count: boundedCounter(stats.deniedGlobal) },
    { reason: "principal_limit", count: boundedCounter(stats.deniedPrincipal) },
    { reason: "principal_capacity", count: boundedCounter(stats.deniedPrincipalCapacity) },
  ];
  reservations.sort((left, right) => WS_REASON_ORDER.indexOf(left.reason) - WS_REASON_ORDER.indexOf(right.reason));

  return {
    enabled: true,
    requests: normalizedRequests(input.requests),
    buckets: {
      principals: boundedCounter(input.buckets.principals),
      overflowSurfaces: boundedCounter(input.buckets.overflowSurfaces),
    },
    websocket: {
      currentGlobal: boundedCounter(input.websocket.globalCount),
      trackedPrincipals: boundedCounter(input.websocket.trackedPrincipals),
      reservations,
    },
  };
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function labels(values: Record<string, string>): string {
  return `{${Object.entries(values)
    .map(([name, value]) => `${name}="${escapeLabel(value)}"`)
    .join(",")}}`;
}

/** Append only bounded, aggregate rate-limit series. This function is read-only. */
export function appendRateLimitPrometheus(
  lines: string[],
  snapshot: Readonly<RateLimitMetricsSnapshot> | null | undefined,
): void {
  if (!snapshot) return;

  lines.push("# HELP opencodex_rate_limit_requests_total Admission decisions by bounded surface, bucket source and result.");
  lines.push("# TYPE opencodex_rate_limit_requests_total counter");
  for (const row of snapshot.requests) {
    lines.push(`opencodex_rate_limit_requests_total${labels({
      surface: row.surface,
      source: row.source,
      result: row.result,
    })} ${row.count}`);
  }

  lines.push("# HELP opencodex_rate_limit_websocket_reservations_total WebSocket concurrency reservation outcomes by bounded reason.");
  lines.push("# TYPE opencodex_rate_limit_websocket_reservations_total counter");
  for (const row of snapshot.websocket.reservations) {
    lines.push(`opencodex_rate_limit_websocket_reservations_total${labels({ reason: row.reason })} ${row.count}`);
  }

  lines.push("# HELP opencodex_rate_limit_websocket_connections Current admitted WebSocket concurrency.");
  lines.push("# TYPE opencodex_rate_limit_websocket_connections gauge");
  lines.push(`opencodex_rate_limit_websocket_connections ${snapshot.websocket.currentGlobal}`);

  lines.push("# HELP opencodex_rate_limit_websocket_tracked_principals Current number of principals with admitted WebSockets.");
  lines.push("# TYPE opencodex_rate_limit_websocket_tracked_principals gauge");
  lines.push(`opencodex_rate_limit_websocket_tracked_principals ${snapshot.websocket.trackedPrincipals}`);

  lines.push("# HELP opencodex_rate_limit_principal_buckets Current allocated principal token buckets.");
  lines.push("# TYPE opencodex_rate_limit_principal_buckets gauge");
  lines.push(`opencodex_rate_limit_principal_buckets ${snapshot.buckets.principals}`);

  lines.push("# HELP opencodex_rate_limit_overflow_surfaces Current surfaces using a bounded shared overflow bucket.");
  lines.push("# TYPE opencodex_rate_limit_overflow_surfaces gauge");
  lines.push(`opencodex_rate_limit_overflow_surfaces ${snapshot.buckets.overflowSurfaces}`);
}
