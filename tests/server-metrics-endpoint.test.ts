import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { runtimeMetrics } from "../src/observability/metrics";
import { resetUsageLogMetricsObserverForTests } from "../src/observability/usage-log-metrics";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import {
  appendUsageEntry,
  subscribeUsageAppends,
  usageLogPath,
  type PersistedUsageEntry,
} from "../src/usage/log";

const previousHome = process.env.OPENCODEX_HOME;
const previousDataToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
let testHome = "";

function remoteConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "0.0.0.0",
    defaultProvider: "test",
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        disabled: true,
        models: ["gpt-test"],
      },
    },
  };
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-metrics-endpoint-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.OPENCODEX_API_AUTH_TOKEN = "data-secret";
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "admin-secret";
});

afterEach(() => {
  resetUsageLogMetricsObserverForTests();
  runtimeMetrics.reset();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDataToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousDataToken;
  if (previousAdminToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdminToken;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = "";
});

describe("GET /metrics management boundary", () => {
  test("scrape endpoint accepts only the management credential and serves Prometheus text", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const unauthenticated = await fetch(new URL("/metrics", server.url));
      expect(unauthenticated.status).toBe(401);

      const withDataToken = await fetch(new URL("/metrics", server.url), {
        headers: { "x-opencodex-api-key": "data-secret" },
      });
      expect(withDataToken.status).toBe(401);

      const withAdminToken = await fetch(new URL("/metrics", server.url), {
        headers: { "x-opencodex-api-key": "admin-secret" },
      });
      expect(withAdminToken.status).toBe(200);
      expect(withAdminToken.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
      expect(withAdminToken.headers.get("cache-control")).toBe("no-store");
      const body = await withAdminToken.text();
      expect(body).toContain("# TYPE opencodex_requests_total counter");
      expect(body).toContain("opencodex_process_uptime_seconds");
    } finally {
      await server.stop(true);
    }
  });

  test("scrapes observe live appends once across repeated startups and read no usage-log file", async () => {
    saveConfig(remoteConfig());
    resetUsageLogMetricsObserverForTests();
    runtimeMetrics.reset();

    const entry: PersistedUsageEntry = {
      requestId: "secret-request-id",
      timestamp: 100,
      provider: "secret-provider",
      model: "secret-model",
      status: 200,
      durationMs: 125,
      usageStatus: "reported",
      terminalStatus: "completed",
      usage: { inputTokens: 10, outputTokens: 4 },
    };

    // Repeated startServer(0) must share one observer registration, never stack them.
    const firstServer = startServer(0);
    await firstServer.stop(true);
    const server = startServer(0);
    // Scrapes must never invoke the append recorder: a spy observer registered
    // alongside the metrics observer sees appends only, never scrape traffic.
    const observedAppends: number[] = [];
    const unsubscribeSpy = subscribeUsageAppends(() => observedAppends.push(1));
    try {
      appendUsageEntry(entry);
      expect(observedAppends).toHaveLength(1);

      const scrape = async (): Promise<string> => {
        const response = await fetch(new URL("/metrics", server.url), {
          headers: { "x-opencodex-api-key": "admin-secret" },
        });
        expect(response.status).toBe(200);
        return await response.text();
      };

      const requestSeries = 'opencodex_requests_total{surface="codex",status_class="2xx",terminal_status="completed"} 1';
      const body = await scrape();
      expect(body).toContain(requestSeries);
      expect(body).toContain('opencodex_tokens_total{surface="codex",type="input"} 10');
      expect(body).not.toContain("secret");

      // Rewrite the entire usage.jsonl on disk (rotation/copytruncate stand-in). The
      // scrape and the JSON snapshot must not change: metrics observe the append
      // boundary and perform zero usage-log filesystem I/O at scrape time.
      writeFileSync(usageLogPath(), Array.from({ length: 50 }, (_, index) => JSON.stringify({
        ...entry,
        requestId: `rewritten-${index}`,
      })).join("\n"), "utf8");
      expect(await scrape()).toContain(requestSeries);

      const json = await fetch(new URL("/api/metrics/json", server.url), {
        headers: { "x-opencodex-api-key": "admin-secret" },
      });
      expect(json.status).toBe(200);
      const snapshot = await json.json() as { requests: Array<{ count: number }> };
      expect(snapshot.requests).toEqual([
        { surface: "codex", statusClass: "2xx", terminalStatus: "completed", count: 1 },
      ]);

      // Both Prometheus scrapes and the JSON snapshot ran; the recorder never fired again.
      expect(observedAppends).toHaveLength(1);
    } finally {
      unsubscribeSpy();
      await server.stop(true);
    }
  });

  test("/api/metrics/json stays behind the same management gate", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const unauthenticated = await fetch(new URL("/api/metrics/json", server.url));
      expect(unauthenticated.status).toBe(401);

      const withDataToken = await fetch(new URL("/api/metrics/json", server.url), {
        headers: { "x-opencodex-api-key": "data-secret" },
      });
      expect(withDataToken.status).toBe(401);

      const withAdminToken = await fetch(new URL("/api/metrics/json", server.url), {
        headers: { "x-opencodex-api-key": "admin-secret" },
      });
      expect(withAdminToken.status).toBe(200);
      expect(withAdminToken.headers.get("content-type") ?? "").toContain("application/json");
      const snapshot = await withAdminToken.json() as Record<string, unknown>;
      expect(snapshot).toHaveProperty("process");
    } finally {
      await server.stop(true);
    }
  });
});
