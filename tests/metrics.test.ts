import { describe, expect, test } from "bun:test";
import {
  FIRST_OUTPUT_BUCKETS_MS,
  REQUEST_DURATION_BUCKETS_MS,
  RuntimeMetrics,
  metricStatusClass,
  metricSurface,
  metricTerminalStatus,
} from "../src/observability/metrics";
import type { RequestLogEntry } from "../src/server/request-log";
import type { RateLimitAggregateSnapshot } from "../src/server/rate-limit";

function entry(overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    requestId: "secret-request-id",
    timestamp: 100,
    model: "secret-model-id",
    provider: "secret-provider-account",
    status: 200,
    durationMs: 125,
    usageStatus: "reported",
    terminalStatus: "completed",
    firstOutputMs: 40,
    usage: {
      inputTokens: 10,
      outputTokens: 4,
      cachedInputTokens: 3,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 2,
      reasoningOutputTokens: 1,
    },
    ...overrides,
  };
}

function fixedProcess() {
  return {
    uptimeSeconds: 12.5,
    residentMemoryBytes: 1_000,
    heapUsedBytes: 200,
    heapTotalBytes: 400,
    externalMemoryBytes: 50,
    arrayBuffersBytes: 25,
    activeTurns: 3,
    draining: true,
  };
}

describe("metrics classification", () => {
  test("keeps labels inside fixed bounded enums", () => {
    expect(metricSurface(undefined)).toBe("codex");
    expect(metricSurface("claude")).toBe("claude");
    expect(metricSurface("untrusted-surface")).toBe("unknown");
    expect(metricStatusClass(204)).toBe("2xx");
    expect(metricStatusClass(499)).toBe("4xx");
    expect(metricStatusClass(Number.NaN)).toBe("unknown");
    expect(metricTerminalStatus("failed")).toBe("failed");
    expect(metricTerminalStatus("untrusted-terminal")).toBe("none");
  });
});

describe("runtime metrics", () => {
  test("records counters, cumulative histograms, tokens, and process gauges", () => {
    const metrics = new RuntimeMetrics(fixedProcess, () => 1_234);
    metrics.recordRequest(entry());
    metrics.recordRequest(entry({
      requestId: "another-secret-id",
      surface: "claude",
      status: 429,
      terminalStatus: "failed",
      durationMs: 2_000,
      firstOutputMs: undefined,
      usage: { inputTokens: 6, outputTokens: 2 },
    }));

    const snapshot = metrics.snapshot();

    expect(snapshot).toMatchObject({
      version: 1,
      generatedAt: 1_234,
      process: fixedProcess(),
      requests: [
        { surface: "codex", statusClass: "2xx", terminalStatus: "completed", count: 1 },
        { surface: "claude", statusClass: "4xx", terminalStatus: "failed", count: 1 },
      ],
    });

    const codexDuration = snapshot.requestDurationMs.find(value => value.surface === "codex");
    expect(codexDuration?.count).toBe(1);
    expect(codexDuration?.sum).toBe(125);
    expect(codexDuration?.buckets).toHaveLength(REQUEST_DURATION_BUCKETS_MS.length);
    expect(codexDuration?.buckets.find(bucket => bucket.le === 100)?.count).toBe(0);
    expect(codexDuration?.buckets.find(bucket => bucket.le === 250)?.count).toBe(1);

    const claudeDuration = snapshot.requestDurationMs.find(value => value.surface === "claude");
    expect(claudeDuration?.buckets.find(bucket => bucket.le === 1_000)?.count).toBe(0);
    expect(claudeDuration?.buckets.find(bucket => bucket.le === 2_500)?.count).toBe(1);

    const codexFirstOutput = snapshot.firstOutputMs.find(value => value.surface === "codex");
    expect(codexFirstOutput?.count).toBe(1);
    expect(codexFirstOutput?.buckets).toHaveLength(FIRST_OUTPUT_BUCKETS_MS.length);
    expect(snapshot.firstOutputMs.some(value => value.surface === "claude")).toBe(false);

    expect(snapshot.tokens).toEqual([
      { surface: "codex", type: "input", count: 10 },
      { surface: "codex", type: "output", count: 4 },
      { surface: "codex", type: "cache_read", count: 3 },
      { surface: "codex", type: "cache_write", count: 2 },
      { surface: "codex", type: "reasoning_output", count: 1 },
      { surface: "claude", type: "input", count: 6 },
      { surface: "claude", type: "output", count: 2 },
      { surface: "claude", type: "cache_read", count: 0 },
      { surface: "claude", type: "cache_write", count: 0 },
      { surface: "claude", type: "reasoning_output", count: 0 },
    ]);
  });

  test("normalizes malformed numeric input and resets process counters", () => {
    const metrics = new RuntimeMetrics(() => ({
      uptimeSeconds: Number.NaN,
      residentMemoryBytes: Number.POSITIVE_INFINITY,
      heapUsedBytes: -1,
      heapTotalBytes: 4.9,
      externalMemoryBytes: 5.9,
      arrayBuffersBytes: -10,
      activeTurns: 2.9,
      draining: false,
    }), () => Number.POSITIVE_INFINITY);

    metrics.recordRequest(entry({
      status: Number.NaN,
      durationMs: Number.POSITIVE_INFINITY,
      firstOutputMs: -1,
      usage: {
        inputTokens: Number.NaN,
        outputTokens: Number.POSITIVE_INFINITY,
        cacheReadInputTokens: -2,
      },
    }));

    expect(metrics.snapshot()).toMatchObject({
      generatedAt: 0,
      process: {
        uptimeSeconds: 0,
        residentMemoryBytes: 0,
        heapUsedBytes: 0,
        heapTotalBytes: 4,
        externalMemoryBytes: 5,
        arrayBuffersBytes: 0,
        activeTurns: 2,
        draining: false,
      },
      requests: [{ statusClass: "unknown", count: 1 }],
      requestDurationMs: [{ count: 0, sum: 0 }],
      firstOutputMs: [],
    });

    metrics.reset();
    expect(metrics.snapshot().requests).toEqual([]);
    expect(metrics.snapshot().tokens).toEqual([]);
  });

  test("exports valid bounded Prometheus text without sensitive dimensions", () => {
    const metrics = new RuntimeMetrics(fixedProcess, () => 1_234);
    metrics.recordRequest(entry({
      upstreamError: "Bearer secret-token",
      conversationId: "secret-conversation",
    }));

    const text = metrics.prometheus();

    expect(text).toContain("# TYPE opencodex_requests_total counter");
    expect(text).toContain('opencodex_requests_total{surface="codex",status_class="2xx",terminal_status="completed"} 1');
    expect(text).toContain('opencodex_request_duration_ms_bucket{surface="codex",le="250"} 1');
    expect(text).toContain('opencodex_request_duration_ms_bucket{surface="codex",le="+Inf"} 1');
    expect(text).toContain('opencodex_tokens_total{surface="codex",type="input"} 10');
    expect(text).toContain("opencodex_active_turns 3");
    expect(text).toContain("opencodex_draining 1");
    expect(text.endsWith("\n")).toBe(true);

    for (const secret of [
      "secret-request-id",
      "secret-model-id",
      "secret-provider-account",
      "secret-conversation",
      "secret-token",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain("provider=");
    expect(text).not.toContain("model=");
    expect(text).not.toContain("request_id=");
  });
});

function rateLimitAggregate(): RateLimitAggregateSnapshot {
  return {
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
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      keys.add(key);
      collectKeys(nested, keys);
    }
  }
  return keys;
}

describe("runtime metrics rate-limit collector", () => {
  test("snapshot omits the subtree without a collector and projects it with one", () => {
    const metrics = new RuntimeMetrics(fixedProcess, () => 1_234);
    expect("rateLimit" in metrics.snapshot()).toBe(false);

    metrics.setRateLimitCollector(rateLimitAggregate);
    expect(metrics.snapshot().rateLimit).toEqual({
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

    metrics.setRateLimitCollector(null);
    expect("rateLimit" in metrics.snapshot()).toBe(false);
  });

  test("prometheus renders the exact bounded rate-limit series once per scrape", () => {
    const metrics = new RuntimeMetrics(fixedProcess, () => 1_234);
    let calls = 0;
    metrics.setRateLimitCollector(() => {
      calls += 1;
      return rateLimitAggregate();
    });

    const text = metrics.prometheus();
    expect(calls).toBe(1);
    expect(text).toContain("# TYPE opencodex_rate_limit_requests_total counter");
    expect(text).toContain('opencodex_rate_limit_requests_total{surface="management",source="principal",result="allowed"} 7');
    expect(text).toContain('opencodex_rate_limit_requests_total{surface="live",source="overflow",result="denied"} 3');
    expect(text).toContain('opencodex_rate_limit_websocket_reservations_total{reason="accepted"} 5');
    expect(text).toContain('opencodex_rate_limit_websocket_reservations_total{reason="global_limit"} 1');
    expect(text).toContain('opencodex_rate_limit_websocket_reservations_total{reason="principal_limit"} 2');
    expect(text).toContain('opencodex_rate_limit_websocket_reservations_total{reason="principal_capacity"} 1');
    expect(text).toContain("opencodex_rate_limit_websocket_connections 2");
    expect(text).toContain("opencodex_rate_limit_websocket_tracked_principals 2");
    expect(text).toContain("opencodex_rate_limit_principal_buckets 4");
    expect(text).toContain("opencodex_rate_limit_overflow_surfaces 1");

    // Rate-limit series carry only the fixed bounded label names.
    for (const line of text.split("\n")) {
      if (!line.startsWith("opencodex_rate_limit_") || !line.includes("{")) continue;
      const labelNames = [...line.matchAll(/(\w+)="/g)].map(match => match[1]);
      for (const name of labelNames) {
        expect(["surface", "source", "result", "reason"]).toContain(name);
      }
    }
  });

  test("collector runs at most once per snapshot and once per prometheus render", () => {
    const metrics = new RuntimeMetrics(fixedProcess, () => 1_234);
    let calls = 0;
    metrics.setRateLimitCollector(() => {
      calls += 1;
      return rateLimitAggregate();
    });

    metrics.snapshot();
    expect(calls).toBe(1);
    metrics.prometheus();
    expect(calls).toBe(2);
  });

  test("disabled aggregates and throwing collectors fail closed", () => {
    const metrics = new RuntimeMetrics(fixedProcess, () => 1_234);
    metrics.recordRequest(entry());

    metrics.setRateLimitCollector(() => ({ ...rateLimitAggregate(), enabled: false }));
    expect("rateLimit" in metrics.snapshot()).toBe(false);
    expect(metrics.prometheus()).not.toContain("opencodex_rate_limit_");

    metrics.setRateLimitCollector(() => {
      throw new Error("collector failure");
    });
    const snapshot = metrics.snapshot();
    expect("rateLimit" in snapshot).toBe(false);
    const text = metrics.prometheus();
    expect(text).not.toContain("opencodex_rate_limit_");
    // The rest of the registry still renders when the collector fails.
    expect(text).toContain('opencodex_requests_total{surface="codex",status_class="2xx",terminal_status="completed"} 1');
  });

  test("projected output is detached from the collector aggregate", () => {
    const source = rateLimitAggregate();
    const metrics = new RuntimeMetrics(fixedProcess, () => 1_234);
    metrics.setRateLimitCollector(() => source);

    const first = metrics.snapshot().rateLimit!;
    expect(first.requests).not.toBe(source.requests);
    first.requests[0].count = 999_999;
    first.websocket.reservations[0].count = 999_999;
    first.buckets.principals = 999_999;

    expect(source.requests.find(row => row.surface === "management")?.count).toBe(7);
    expect(source.websocket.stats.accepted).toBe(5);
    expect(source.buckets.principals).toBe(4);
    expect(metrics.snapshot().rateLimit).toEqual({
      ...first,
      requests: [
        { surface: "management", source: "principal", result: "allowed", count: 7 },
        { surface: "live", source: "overflow", result: "denied", count: 3 },
      ],
      buckets: { principals: 4, overflowSurfaces: 1 },
      websocket: {
        ...first.websocket,
        reservations: [
          { reason: "accepted", count: 5 },
          { reason: "global_limit", count: 1 },
          { reason: "principal_limit", count: 2 },
          { reason: "principal_capacity", count: 1 },
        ],
      },
    });
  });

  test("reset clears the collector for test/server isolation", () => {
    const metrics = new RuntimeMetrics(fixedProcess, () => 1_234);
    let calls = 0;
    metrics.setRateLimitCollector(() => {
      calls += 1;
      return rateLimitAggregate();
    });

    metrics.reset();
    expect("rateLimit" in metrics.snapshot()).toBe(false);
    expect(metrics.prometheus()).not.toContain("opencodex_rate_limit_");
    expect(calls).toBe(0);
  });

  test("rate-limit subtree carries only bounded aggregate fields", () => {
    const metrics = new RuntimeMetrics(fixedProcess, () => 1_234);
    metrics.setRateLimitCollector(rateLimitAggregate);

    const keys = collectKeys(metrics.snapshot().rateLimit);
    expect([...keys].sort()).toEqual([
      "buckets",
      "count",
      "currentGlobal",
      "enabled",
      "overflowSurfaces",
      "principals",
      "reason",
      "requests",
      "reservations",
      "result",
      "source",
      "surface",
      "trackedPrincipals",
      "websocket",
    ]);
    const serialized = JSON.stringify(metrics.snapshot().rateLimit);
    expect(serialized).not.toMatch(/fingerprint|credential|authorization|origin|address|provider|model|account|requestId|request_id|conversation|prompt|error/i);
  });
});
