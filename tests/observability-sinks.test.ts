import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clickhouseInsertRow,
  clickhouseServerSettings,
  resetServerClickhouse,
} from "../src/telemetry/clickhouse-server";
import {
  datadogLogRecord,
  datadogServerSettings,
  getServerDatadog,
  resetServerDatadog,
} from "../src/telemetry/datadog-server";
import {
  datadogBrowserIntakeOrigin,
  datadogLogsIntakeUrl,
} from "../src/telemetry/datadog-sites";
import {
  captureRequestTelemetry,
  resetServerPosthog,
} from "../src/telemetry/posthog-server";
import { sanitizeTelemetryProperties } from "../src/telemetry/sanitize";

const originalFetch = globalThis.fetch;
const ENV_KEYS = [
  "OCX_DATADOG_API_KEY",
  "OCX_DATADOG_SITE",
  "DD_API_KEY",
  "DD_SITE",
  "OCX_CLICKHOUSE_URL",
  "OCX_CLICKHOUSE_DATABASE",
  "OCX_CLICKHOUSE_TABLE",
  "OCX_CLICKHOUSE_USER",
  "OCX_CLICKHOUSE_PASSWORD",
  "OCX_CLICKHOUSE_PASSWORD_FILE",
  "OCX_CLICKHOUSE_AUTO_SCHEMA",
  "OCX_POSTHOG_KEY",
] as const;

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) delete process.env[key];
  resetServerDatadog();
  resetServerClickhouse();
  resetServerPosthog();
});

describe("telemetry sinks", () => {
  test("drops undeclared properties and keeps metric fields", () => {
    const clean = sanitizeTelemetryProperties({
      provider: "openai",
      status: 200,
      prompt: "do not keep",
      authorization: "Bearer secret",
      durationMs: 12,
    });
    expect(clean).toEqual({ provider: "openai", status: 200, durationMs: 12 });
  });

  test("Datadog stays off without a key and rejects an unknown site", () => {
    expect(datadogServerSettings({})).toBeUndefined();
    expect(
      datadogServerSettings({
        OCX_DATADOG_API_KEY: "dd-test-key",
        OCX_DATADOG_SITE: "https://evil.example",
      }),
    ).toBeUndefined();
    expect(datadogLogsIntakeUrl("app.datadoghq.eu")).toBe(
      "https://http-intake.logs.datadoghq.eu/api/v2/logs",
    );
    expect(datadogBrowserIntakeOrigin("datadoghq.eu")).toBe(
      "https://browser-intake-datadoghq.eu",
    );
  });

  test("Datadog log records do not contain the API key", () => {
    const record = datadogLogRecord("proxy_request_terminal", {
      provider: "openai",
      status: 200,
      outcome: "success",
      apiKey: "dd-test-key",
    });
    expect(record.message).toBe("proxy_request_terminal");
    expect(record.status).toBe("info");
    expect(record.http_status).toBe(200);
    expect(JSON.stringify(record)).not.toContain("dd-test-key");
  });

  test("a configured Datadog sink posts allowlisted fields to the EU intake", async () => {
    process.env.OCX_DATADOG_API_KEY = "dd-test-key";
    const calls: Array<{ url: string; key: string | null; body: string }> = [];
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        key: headers.get("DD-API-KEY"),
        body: String(init?.body ?? ""),
      });
      return new Response("{}", { status: 202 });
    }) as typeof fetch;
    captureRequestTelemetry({
      requestId: "req-dd",
      provider: "openai",
      model: "gpt-4o-mini",
      status: 200,
      durationMs: 15,
      usageStatus: "unreported",
    });
    await getServerDatadog()?.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://http-intake.logs.datadoghq.eu/api/v2/logs",
    );
    expect(calls[0]?.key).toBe("dd-test-key");
    expect(calls[0]?.body).not.toContain("dd-test-key");
    expect(calls[0]?.body).toContain("gpt-4o-mini");
    expect(calls[0]?.body).not.toContain("req-dd");
  });

  test("ClickHouse rejects userinfo and a missing password file", () => {
    expect(
      clickhouseServerSettings({
        OCX_CLICKHOUSE_URL: "http://user:secret@127.0.0.1:8123",
      }),
    ).toBeUndefined();
    expect(
      clickhouseServerSettings({ OCX_CLICKHOUSE_URL: "file:///tmp/events" }),
    ).toBeUndefined();
    expect(
      clickhouseServerSettings({
        OCX_CLICKHOUSE_URL: "http://127.0.0.1:8123",
        OCX_CLICKHOUSE_PASSWORD_FILE: join(
          tmpdir(),
          "missing-ocx-clickhouse-password",
        ),
      }),
    ).toBeUndefined();
    const remote = clickhouseServerSettings({
      OCX_CLICKHOUSE_URL: "https://clickhouse.example.com",
    });
    expect(remote?.autoSchema).toBe(false);
    expect(
      clickhouseServerSettings({ OCX_CLICKHOUSE_URL: "http://127.0.0.1:8123" })
        ?.autoSchema,
    ).toBe(true);
  });

  test("ClickHouse inserts do not put the password in the URL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-ch-"));
    const passwordFile = join(dir, "password");
    writeFileSync(passwordFile, "clickhouse-secret-value\n", { mode: 0o600 });
    process.env.OCX_CLICKHOUSE_URL = "http://127.0.0.1:8123";
    process.env.OCX_CLICKHOUSE_PASSWORD_FILE = passwordFile;
    process.env.OCX_CLICKHOUSE_AUTO_SCHEMA = "0";
    const calls: Array<{ url: string; key: string | null; body: string }> = [];
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        key: headers.get("X-ClickHouse-Key"),
        body: String(init?.body ?? ""),
      });
      return new Response("Ok.", { status: 200 });
    }) as typeof fetch;
    const { captureClickhouseEvent, getServerClickhouse } =
      await import("../src/telemetry/clickhouse-server");
    captureClickhouseEvent("proxy_request_terminal", {
      provider: "openai",
      model: "gpt-4o-mini",
      status: 204,
      durationMs: 8,
      outcome: "success",
      prompt: "hidden",
    });
    await getServerClickhouse()?.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).not.toContain("clickhouse-secret-value");
    const insertUrl = new URL(calls[0]?.url ?? "");
    expect(insertUrl.searchParams.get("query")).toContain(
      "INSERT INTO opencodex.ocx_events FORMAT JSONEachRow",
    );
    expect(calls[0]?.key).toBe("clickhouse-secret-value");
    expect(calls[0]?.body).not.toContain("hidden");
    expect(calls[0]?.body).not.toContain("clickhouse-secret-value");
    const row = clickhouseInsertRow("proxy_request_terminal", {
      provider: "openai",
      status: 204,
      durationMs: 8,
    });
    expect(row.provider).toBe("openai");
    expect(row.status).toBe(204);
    rmSync(dir, { recursive: true, force: true });
  });

  test("the dashboard client lists the same browser intake origins", async () => {
    const source = await Bun.file(
      new URL("../gui/src/datadog.ts", import.meta.url),
    ).text();
    for (const site of [
      "datadoghq.eu",
      "datadoghq.com",
      "uk1.datadoghq.com",
      "us2.ddog-gov.com",
    ]) {
      const origin = datadogBrowserIntakeOrigin(site);
      expect(origin).toBeTruthy();
      expect(source).toContain(origin!);
    }
  });
});
