/**
 * Opt-in Datadog log intake for the proxy. Enabled only when OCX_DATADOG_API_KEY
 * (or DD_API_KEY) is set. Events use the same allowlist as PostHog. The API key
 * is sent as the DD-API-KEY header and is never written to logs or the body.
 *
 * https://docs.datadoghq.com/api/latest/logs/ (Send logs, HTTP v2)
 */
import { datadogLogsIntakeUrl, DEFAULT_DATADOG_SITE } from "./datadog-sites";
import { sanitizeTelemetryProperties } from "./sanitize";

const FLUSH_INTERVAL_MS = 10_000;
const MAX_BATCH_SIZE = 50;
const MAX_QUEUE_SIZE = 200;

type Environment = Record<string, string | undefined>;

export interface DatadogSettings {
  apiKey: string;
  intakeUrl: string;
  site: string;
}

export function datadogServerSettings(
  env: Environment,
): DatadogSettings | undefined {
  const apiKey = env.OCX_DATADOG_API_KEY?.trim() || env.DD_API_KEY?.trim();
  if (!apiKey) return undefined;
  const site =
    env.OCX_DATADOG_SITE?.trim() || env.DD_SITE?.trim() || DEFAULT_DATADOG_SITE;
  const intakeUrl = datadogLogsIntakeUrl(site);
  if (!intakeUrl) return undefined;
  return { apiKey, intakeUrl, site };
}

export function datadogLogRecord(
  event: string,
  properties: Record<string, unknown> | undefined,
) {
  const safe = sanitizeTelemetryProperties(properties);
  const outcome = safe.outcome === "error" ? "error" : "info";
  const httpStatus = safe.status;
  return {
    ...safe,
    ...(typeof httpStatus === "number" ? { http_status: httpStatus } : {}),
    ddsource: "opencodex",
    ddtags: "service:opencodex",
    hostname: "opencodex",
    service: "opencodex",
    message: event,
    status: outcome,
  };
}

export class DatadogClient {
  private readonly queue: Array<{
    event: string;
    properties: Record<string, unknown>;
  }> = [];
  private readonly timer: ReturnType<typeof setInterval> | null;
  private flushing = false;

  constructor(
    private readonly settings: DatadogSettings,
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

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue.splice(0, MAX_BATCH_SIZE);
    try {
      const body = JSON.stringify(
        batch.map((entry) => datadogLogRecord(entry.event, entry.properties)),
      );
      const res = await this.send(this.settings.intakeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "DD-API-KEY": this.settings.apiKey,
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) void res.body?.cancel().catch(() => {});
    } catch {
      /* drop the batch; a telemetry outage must not retry forever on the request path */
    } finally {
      this.flushing = false;
    }
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    void this.flush();
  }
}

let cached: DatadogClient | null | undefined;

export function getServerDatadog(
  env: Environment = process.env,
): DatadogClient | null {
  if (cached !== undefined) return cached;
  try {
    const settings = datadogServerSettings(env);
    cached = settings ? new DatadogClient(settings) : null;
    return cached;
  } catch {
    cached = null;
    return null;
  }
}

export function captureDatadogEvent(
  event: string,
  properties?: Record<string, unknown>,
): void {
  try {
    getServerDatadog()?.capture(event, properties);
  } catch {
    /* optional */
  }
}

export function resetServerDatadog(): void {
  if (cached) cached.shutdown();
  cached = undefined;
}
