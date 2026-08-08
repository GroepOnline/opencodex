import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeMetrics, runtimeMetrics } from "../src/observability/metrics";
import {
  ensureUsageLogMetricsObserver,
  resetUsageLogMetricsObserverForTests,
} from "../src/observability/usage-log-metrics";
import {
  appendUsageEntry,
  subscribeUsageAppends,
  usageLogPath,
  type PersistedUsageEntry,
  type UsageAppendObservation,
} from "../src/usage/log";

const previousHome = process.env.OPENCODEX_HOME;
let testHome = "";
const cleanups: Array<() => void> = [];

function subscribe(observer: (observation: UsageAppendObservation) => void): () => void {
  const unsubscribe = subscribeUsageAppends(observer);
  cleanups.push(unsubscribe);
  return unsubscribe;
}

function fixedProcess() {
  return {
    uptimeSeconds: 1,
    residentMemoryBytes: 2,
    heapUsedBytes: 3,
    heapTotalBytes: 4,
    externalMemoryBytes: 5,
    arrayBuffersBytes: 6,
    activeTurns: 0,
    draining: false,
  };
}

function usageEntry(overrides: Partial<PersistedUsageEntry> = {}): PersistedUsageEntry {
  return {
    requestId: "secret-request-id",
    timestamp: 100,
    provider: "secret-provider-account",
    model: "secret-model-id",
    conversationId: "secret-conversation",
    status: 200,
    durationMs: 125,
    firstOutputMs: 40,
    usageStatus: "reported",
    terminalStatus: "completed",
    usage: {
      inputTokens: 10,
      outputTokens: 4,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 2,
      reasoningOutputTokens: 1,
    },
    ...overrides,
  };
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-usage-observer-"));
  process.env.OPENCODEX_HOME = testHome;
  resetUsageLogMetricsObserverForTests();
});

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  resetUsageLogMetricsObserverForTests();
  runtimeMetrics.reset();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = "";
});

describe("usage append observers", () => {
  test("counts only appends made after registration; existing history is never replayed", () => {
    appendUsageEntry(usageEntry({ requestId: "historical" }));

    const metrics = new RuntimeMetrics(fixedProcess, () => 10);
    const seen: UsageAppendObservation[] = [];
    subscribe(observation => {
      seen.push(observation);
      metrics.recordRequest(observation);
    });

    appendUsageEntry(usageEntry({ requestId: "live", status: 429, terminalStatus: "failed" }));

    expect(seen).toHaveLength(1);
    expect(metrics.snapshot().requests).toEqual([
      { surface: "codex", statusClass: "4xx", terminalStatus: "failed", count: 1 },
    ]);
    // Both rows are on disk; only the post-registration one was observed.
    expect(readFileSync(usageLogPath(), "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("a successful append emits exactly one safe structural observation", () => {
    const seen: UsageAppendObservation[] = [];
    subscribe(observation => seen.push(observation));

    appendUsageEntry(usageEntry({
      surface: "claude",
      errorCode: "secret-error-code",
      upstreamError: "Bearer secret-token",
    }));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      surface: "claude",
      status: 200,
      durationMs: 125,
      firstOutputMs: 40,
      terminalStatus: "completed",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 2,
        reasoningOutputTokens: 1,
      },
    });
    const serialized = JSON.stringify(seen[0]);
    for (const secret of [
      "secret-request-id",
      "secret-provider-account",
      "secret-model-id",
      "secret-conversation",
      "secret-error-code",
      "Bearer",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test("raw dimensions never reach the Prometheus output through the observer", () => {
    const metrics = new RuntimeMetrics(fixedProcess, () => 10);
    subscribe(observation => metrics.recordRequest(observation));

    appendUsageEntry(usageEntry({ provider: "Bearer secret", model: "secret-model-id" }));

    expect(metrics.snapshot().requests[0]!.count).toBe(1);
    const output = metrics.prometheus();
    expect(output).not.toContain("secret");
    expect(output).not.toContain("Bearer");
    expect(output).toContain('opencodex_requests_total{surface="codex",status_class="2xx",terminal_status="completed"} 1');
  });

  test("an append failure emits nothing", () => {
    const seen: UsageAppendObservation[] = [];
    subscribe(observation => seen.push(observation));

    // Occupy the log path with a directory so appendFileSync fails (EISDIR).
    mkdirSync(usageLogPath(), { recursive: true });
    expect(() => appendUsageEntry(usageEntry())).toThrow();
    expect(seen).toHaveLength(0);
  });

  test("observer failures are isolated and ordering follows registration", () => {
    const order: string[] = [];
    const firstSeen: UsageAppendObservation[] = [];
    const secondSeen: UsageAppendObservation[] = [];
    subscribe(observation => {
      order.push("first");
      firstSeen.push(observation);
      throw new Error("observer defect");
    });
    subscribe(observation => {
      order.push("second");
      secondSeen.push(observation);
    });

    expect(() => appendUsageEntry(usageEntry())).not.toThrow();

    expect(order).toEqual(["first", "second"]);
    expect(secondSeen).toHaveLength(1);
    // Each observer receives its own copied usage object.
    expect(firstSeen[0]!.usage).toEqual(secondSeen[0]!.usage);
    expect(firstSeen[0]!.usage).not.toBe(secondSeen[0]!.usage);
    // The row itself was still appended despite the throwing observer.
    expect(readFileSync(usageLogPath(), "utf8")).toContain("secret-request-id");
  });

  test("unsubscribe is idempotent and the registration cap is enforced", () => {
    const unsubscribes: Array<() => void> = [];
    let rejected: unknown = null;
    try {
      for (let index = 0; index < 32; index += 1) {
        unsubscribes.push(subscribeUsageAppends(() => {}));
      }
    } catch (error) {
      rejected = error;
    }
    cleanups.push(...unsubscribes);
    expect(rejected).toBeInstanceOf(RangeError);
    expect((rejected as RangeError).message).toContain("observer limit");
    expect(unsubscribes.length).toBeLessThanOrEqual(8);

    // A double unsubscribe frees exactly one slot, not two.
    const first = unsubscribes[0]!;
    first();
    first();
    const replacement = subscribeUsageAppends(() => {});
    cleanups.push(replacement);
    expect(() => subscribeUsageAppends(() => {})).toThrow(RangeError);
  });

  test("repeated observer initialization does not double-count", () => {
    runtimeMetrics.reset();
    ensureUsageLogMetricsObserver();
    ensureUsageLogMetricsObserver();
    ensureUsageLogMetricsObserver();

    appendUsageEntry(usageEntry());

    expect(runtimeMetrics.snapshot().requests).toEqual([
      { surface: "codex", statusClass: "2xx", terminalStatus: "completed", count: 1 },
    ]);
    expect(runtimeMetrics.snapshot().tokens).toContainEqual({ surface: "codex", type: "input", count: 10 });
  });

  test("malformed structural fields are dropped at the boundary, not forwarded", () => {
    const seen: UsageAppendObservation[] = [];
    subscribe(observation => seen.push(observation));

    appendUsageEntry(usageEntry({
      firstOutputMs: -1,
      terminalStatus: "exotic-terminal",
      surface: "untrusted-surface" as PersistedUsageEntry["surface"],
    }));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      status: 200,
      durationMs: 125,
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 2,
        reasoningOutputTokens: 1,
      },
    });
  });
});
