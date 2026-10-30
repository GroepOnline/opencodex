/**
 * Opt-in ClickHouse HTTP inserts. Enabled only when OCX_CLICKHOUSE_URL is set.
 * Credentials travel in X-ClickHouse-User / X-ClickHouse-Key, never the query
 * string, and failures are swallowed.
 *
 * https://clickhouse.com/docs/interfaces/http
 */
import { readFileSync } from "node:fs";
import { sanitizeTelemetryProperties } from "./sanitize";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FLUSH_INTERVAL_MS = 10_000;
const MAX_BATCH_SIZE = 50;
const MAX_QUEUE_SIZE = 200;

type Environment = Record<string, string | undefined>;

export interface ClickhouseSettings {
  origin: string;
  database: string;
  table: string;
  user: string;
  password?: string;
  autoSchema: boolean;
}

function loopbackHost(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
  );
}

function readSecretFile(path: string | undefined): string | undefined {
  const trimmed = path?.trim();
  if (!trimmed) return undefined;
  try {
    const value = readFileSync(trimmed, "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function clickhouseServerSettings(
  env: Environment,
): ClickhouseSettings | undefined {
  const raw = env.OCX_CLICKHOUSE_URL?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password) return undefined;
  const database = env.OCX_CLICKHOUSE_DATABASE?.trim() || "opencodex";
  const table = env.OCX_CLICKHOUSE_TABLE?.trim() || "ocx_events";
  if (!IDENTIFIER.test(database) || !IDENTIFIER.test(table)) return undefined;
  const filePassword = env.OCX_CLICKHOUSE_PASSWORD_FILE?.trim()
    ? readSecretFile(env.OCX_CLICKHOUSE_PASSWORD_FILE)
    : undefined;
  if (env.OCX_CLICKHOUSE_PASSWORD_FILE?.trim() && !filePassword)
    return undefined;
  const password =
    filePassword || env.OCX_CLICKHOUSE_PASSWORD?.trim() || undefined;
  const autoFlag = env.OCX_CLICKHOUSE_AUTO_SCHEMA?.trim();
  const autoSchema =
    autoFlag === "1" || (autoFlag !== "0" && loopbackHost(url.hostname));
  return {
    origin: url.origin,
    database,
    table,
    user: env.OCX_CLICKHOUSE_USER?.trim() || "default",
    ...(password ? { password } : {}),
    autoSchema,
  };
}

export function clickhouseInsertRow(
  event: string,
  properties: Record<string, unknown> | undefined,
  now = new Date(),
) {
  const safe = sanitizeTelemetryProperties(properties);
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const num = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, Math.trunc(value))
      : 0;
  return {
    ts: now.toISOString().replace("T", " ").replace("Z", ""),
    event,
    provider: text(safe.provider),
    model: text(safe.model),
    status: num(safe.status),
    duration_ms: num(safe.durationMs),
    outcome: text(safe.outcome),
    error_code: text(safe.errorCode),
    surface: text(safe.surface),
  };
}

function schemaSql(settings: ClickhouseSettings): string {
  return `CREATE TABLE IF NOT EXISTS ${settings.database}.${settings.table} (
  ts DateTime64(3, 'UTC'),
  event LowCardinality(String),
  provider LowCardinality(String),
  model LowCardinality(String),
  status UInt16,
  duration_ms UInt32,
  outcome LowCardinality(String),
  error_code LowCardinality(String),
  surface LowCardinality(String)
) ENGINE = MergeTree
ORDER BY (event, ts)`;
}

export class ClickhouseClient {
  private readonly queue: Array<{
    event: string;
    properties: Record<string, unknown>;
  }> = [];
  private readonly timer: ReturnType<typeof setInterval> | null;
  private flushing = false;
  private schemaReady = false;

  constructor(
    private readonly settings: ClickhouseSettings,
    private readonly send: typeof fetch = fetch,
  ) {
    this.timer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  capture(event: string, properties?: Record<string, unknown>): void {
    try {
      this.queue.push({
        event,
        properties: sanitizeTelemetryProperties(properties),
      });
      if (this.queue.length > MAX_QUEUE_SIZE) {
        this.queue.splice(0, this.queue.length - MAX_QUEUE_SIZE);
      }
      if (this.queue.length >= MAX_BATCH_SIZE) void this.flush();
    } catch {
      /* telemetry must never break callers */
    }
  }

  private endpoint(query: string): string {
    const url = new URL(this.settings.origin);
    url.searchParams.set("database", this.settings.database);
    url.searchParams.set("query", query);
    return url.toString();
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "text/plain; charset=utf-8",
    };
    if (this.settings.user) headers["X-ClickHouse-User"] = this.settings.user;
    if (this.settings.password)
      headers["X-ClickHouse-Key"] = this.settings.password;
    return headers;
  }

  private async post(query: string, body: string): Promise<boolean> {
    const res = await this.send(this.endpoint(query), {
      method: "POST",
      headers: this.headers(),
      body,
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      return false;
    }
    void res.body?.cancel().catch(() => {});
    return true;
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue.splice(0, MAX_BATCH_SIZE);
    try {
      if (this.settings.autoSchema && !this.schemaReady) {
        this.schemaReady = await this.post(schemaSql(this.settings), "");
        if (!this.schemaReady) return;
      }
      const lines = batch
        .map((entry) =>
          JSON.stringify(clickhouseInsertRow(entry.event, entry.properties)),
        )
        .join("\n");
      await this.post(
        `INSERT INTO ${this.settings.database}.${this.settings.table} FORMAT JSONEachRow`,
        lines,
      );
    } catch {
      /* network failures stay inside telemetry */
    } finally {
      this.flushing = false;
    }
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    void this.flush();
  }
}

let cached: ClickhouseClient | null | undefined;

export function getServerClickhouse(
  env: Environment = process.env,
): ClickhouseClient | null {
  if (cached !== undefined) return cached;
  try {
    const settings = clickhouseServerSettings(env);
    cached = settings ? new ClickhouseClient(settings) : null;
    return cached;
  } catch {
    cached = null;
    return null;
  }
}

export function captureClickhouseEvent(
  event: string,
  properties?: Record<string, unknown>,
): void {
  try {
    getServerClickhouse()?.capture(event, properties);
  } catch {
    /* optional */
  }
}

export function resetServerClickhouse(): void {
  if (cached) cached.shutdown();
  cached = undefined;
}
