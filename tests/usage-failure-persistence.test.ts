import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeMetrics } from "../src/observability/metrics";
import {
  ensureUsageLogMetricsObserver,
  resetUsageLogMetricsObserverForTests,
} from "../src/observability/usage-log-metrics";
import { addRequestLog } from "../src/server/request-log";
import { subscribeUsageAppends, usageLogPath } from "../src/usage/log";

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-usage-fail-"));
  process.env.OPENCODEX_HOME = testDir;
  resetUsageLogMetricsObserverForTests();
});

afterEach(() => {
  resetUsageLogMetricsObserverForTests();
  runtimeMetrics.reset();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

function lastPersistedLine(): Record<string, unknown> {
  const lines = readFileSync(usageLogPath(), "utf-8").trim().split("\n");
  return JSON.parse(lines.at(-1)!) as Record<string, unknown>;
}

test("5xx entry persists failure diagnostics to usage.jsonl (survives the ring buffer)", () => {
  addRequestLog({
    requestId: "ocx-test-502",
    timestamp: Date.now(),
    model: "gpt-test",
    provider: "openai",
    status: 502,
    durationMs: 191_677,
    usageStatus: "unreported",
    errorCode: "upstream_server_error",
    terminalStatus: "failed",
    closeReason: "terminal",
    upstreamError: "An error occurred while processing your request. request ID test-42",
  });
  const row = lastPersistedLine();
  expect(row.status).toBe(502);
  expect(row.errorCode).toBe("upstream_server_error");
  expect(row.terminalStatus).toBe("failed");
  expect(row.closeReason).toBe("terminal");
  expect(row.upstreamError).toContain("request ID test-42");
});

test("a normal add records exactly one runtime-metrics observation", () => {
  runtimeMetrics.reset();
  ensureUsageLogMetricsObserver();

  addRequestLog({
    requestId: "ocx-test-metrics-once",
    timestamp: Date.now(),
    model: "secret-model",
    provider: "secret-provider",
    status: 200,
    durationMs: 1234,
    usageStatus: "reported",
    terminalStatus: "completed",
    closeReason: "terminal",
    usage: { inputTokens: 10, outputTokens: 2 },
  });

  const snapshot = runtimeMetrics.snapshot();
  // Successful rows persist without diagnostic terminalStatus, so the bounded
  // terminal label is "none"; exactly one request and one token series increment.
  expect(snapshot.requests).toEqual([
    { surface: "codex", statusClass: "2xx", terminalStatus: "none", count: 1 },
  ]);
  expect(snapshot.tokens).toContainEqual({ surface: "codex", type: "input", count: 10 });
  expect(runtimeMetrics.prometheus()).not.toContain("secret");
});

test("a throwing metrics recorder does not prevent usage persistence", () => {
  const unsubscribe = subscribeUsageAppends(() => {
    throw new Error("recorder defect");
  });
  try {
    expect(() => addRequestLog({
      requestId: "ocx-test-recorder-throw",
      timestamp: Date.now(),
      model: "gpt-test",
      provider: "openai",
      status: 200,
      durationMs: 1234,
      usageStatus: "reported",
      usage: { inputTokens: 5, outputTokens: 1 },
    })).not.toThrow();
    const row = lastPersistedLine();
    expect(row.requestId).toBe("ocx-test-recorder-throw");
    expect(row.status).toBe(200);
  } finally {
    unsubscribe();
  }
});

test("successful entry keeps the existing persisted shape (no diagnostic fields)", () => {
  addRequestLog({
    requestId: "ocx-test-200",
    timestamp: Date.now(),
    model: "gpt-test",
    provider: "openai",
    status: 200,
    durationMs: 1234,
    usageStatus: "reported",
    terminalStatus: "completed",
    closeReason: "terminal",
    usage: { inputTokens: 10, outputTokens: 2 },
  });
  const row = lastPersistedLine();
  expect(row.status).toBe(200);
  expect(row.errorCode).toBeUndefined();
  expect(row.terminalStatus).toBeUndefined();
  expect(row.closeReason).toBeUndefined();
  expect(row.upstreamError).toBeUndefined();
});
