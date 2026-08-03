import { describe, expect, test } from "bun:test";
import {
  appendRateLimitPrometheus,
  projectRateLimitMetrics,
} from "../src/observability/rate-limit-projection";
import { RATE_LIMIT_SURFACES } from "../src/ratelimit";
import type { RateLimitAggregateSnapshot } from "../src/server/rate-limit";

const aggregate: RateLimitAggregateSnapshot = {
  enabled: true,
  requests: [
    { surface: "live", source: "overflow", result: "denied", count: 3 },
    { surface: "management", source: "principal", result: "allowed", count: 7 },
  ],
  buckets: { principals: 4, overflowSurfaces: 1 },
  websocket: {
    globalCount: 2,
    trackedPrincipals: 2,
    stats: {
      accepted: 5,
      deniedGlobal: 1,
      deniedPrincipal: 2,
      deniedPrincipalCapacity: 1,
    },
  },
};

describe("rate-limit metrics projection", () => {
  test("disabled and absent admission produce no metrics subtree", () => {
    expect(projectRateLimitMetrics(undefined)).toBeNull();
    expect(projectRateLimitMetrics(null)).toBeNull();
    expect(projectRateLimitMetrics({ ...aggregate, enabled: false })).toBeNull();
  });

  test("projects deterministic aggregate-only JSON", () => {
    expect(projectRateLimitMetrics(aggregate)).toEqual({
      enabled: true,
      requests: [
        { surface: "management", source: "principal", result: "allowed", count: 7 },
        { surface: "live", source: "overflow", result: "denied", count: 3 },
      ],
      buckets: { principals: 4, overflowSurfaces: 1 },
      websocket: {
        currentGlobal: 2,
        trackedPrincipals: 2,
        reservations: [
          { reason: "accepted", count: 5 },
          { reason: "global_limit", count: 1 },
          { reason: "principal_limit", count: 2 },
          { reason: "principal_capacity", count: 1 },
        ],
      },
    });
  });

  test("copies values and clamps invalid counters without mutating the source", () => {
    const source = structuredClone(aggregate);
    source.requests[0] = { ...source.requests[0], count: Number.POSITIVE_INFINITY };
    source.websocket.stats.accepted = -10;
    const projected = projectRateLimitMetrics(source)!;

    expect(projected.requests.find(row => row.surface === "live")?.count).toBe(0);
    expect(projected.websocket.reservations[0]).toEqual({ reason: "accepted", count: 0 });
    projected.requests[0].count = 999;
    expect(source.requests[1].count).toBe(7);
  });

  test("every declared surface is retained in JSON and Prometheus output", () => {
    const source: RateLimitAggregateSnapshot = {
      ...structuredClone(aggregate),
      requests: RATE_LIMIT_SURFACES.map((surface, index) => ({
        surface,
        source: "principal",
        result: "allowed",
        count: index + 1,
      })),
    };
    const projected = projectRateLimitMetrics(source)!;

    expect(projected.requests.map(row => row.surface)).toEqual([...RATE_LIMIT_SURFACES]);

    const lines: string[] = [];
    appendRateLimitPrometheus(lines, projected);
    const text = lines.join("\n");
    for (const surface of RATE_LIMIT_SURFACES) {
      expect(text).toContain(`opencodex_rate_limit_requests_total{surface="${surface}"`);
    }
  });

  test("Prometheus output has fixed labels and gauges only", () => {
    const lines: string[] = [];
    appendRateLimitPrometheus(lines, projectRateLimitMetrics(aggregate));
    const text = `${lines.join("\n")}\n`;

    expect(text).toContain('opencodex_rate_limit_requests_total{surface="management",source="principal",result="allowed"} 7');
    expect(text).toContain('opencodex_rate_limit_requests_total{surface="live",source="overflow",result="denied"} 3');
    expect(text).toContain('opencodex_rate_limit_websocket_reservations_total{reason="principal_limit"} 2');
    expect(text).toContain("opencodex_rate_limit_websocket_connections 2");
    expect(text).toContain("opencodex_rate_limit_websocket_tracked_principals 2");
    expect(text).toContain("opencodex_rate_limit_principal_buckets 4");
    expect(text).toContain("opencodex_rate_limit_overflow_surfaces 1");
  });

  test("serialized output cannot contain identity dimensions", () => {
    const projected = projectRateLimitMetrics(aggregate)!;
    const lines: string[] = [];
    appendRateLimitPrometheus(lines, projected);
    const serialized = `${JSON.stringify(projected)}\n${lines.join("\n")}`;

    expect(serialized).not.toMatch(/fingerprint|credential|authorization|origin|address|provider|model|account|request_id|conversation|prompt|error/i);
  });

  test("rendering is read-only and does not change counters or gauges", () => {
    const projected = projectRateLimitMetrics(aggregate)!;
    const before = structuredClone(projected);
    const lines: string[] = [];
    appendRateLimitPrometheus(lines, projected);
    appendRateLimitPrometheus([], projected);
    expect(projected).toEqual(before);
  });
});
