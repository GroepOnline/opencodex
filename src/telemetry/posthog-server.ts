/**
 * Server-side PostHog telemetry — dependency-free, opt-in, EU-hosted, no PII.
 *
 * Enabled only when OCX_POSTHOG_KEY is set. All errors are swallowed: telemetry
 * must never break a request or crash the proxy. Events are batched and flushed
 * every 10s or 50 events (whichever first) via Bun.fetch to the /capture/ endpoint.
 *
 * Collected properties (NO PII): event name, provider, model, adapter, status,
 * durationMs, firstOutputMs (TTFT), token counts (input/output/cached/reasoning),
 * error codes, and codex account-pool outcomes. Never request bodies, headers,
 * auth tokens, user prompts, or filenames.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { effectiveServiceTier, estimateRequestCost } from "../usage/cost";
import type { UsageStatus } from "../usage/log";
import type { OcxUsage } from "../types";

/**
 * PostHog host. When OCX_POSTHOG_KEY is set, the host defaults to the official
 * EU-hosted PostHog cloud. Override via OCX_POSTHOG_HOST for a self-hosted
 * instance. A deployment-specific default must NOT be hardcoded here —
 * telemetry destination is operator configuration, not source code.
 */
const DEFAULT_HOST = "https://eu.i.posthog.com";
const FLUSH_INTERVAL_MS = 10_000;
const MAX_BATCH_SIZE = 50;
/** Hard cap on buffered events; the oldest are dropped once exceeded. */
const MAX_QUEUE_SIZE = 500;
/** Send attempts per event before it is dropped for good. */
const MAX_SEND_ATTEMPTS = 3;
/** Base delay before retrying a transiently failed batch (doubles per attempt). */
const RETRY_BASE_DELAY_MS = 5_000;

/** Canonical telemetry event names. */
export const TELEMETRY_EVENTS = {
  REQUEST_TERMINAL: "proxy_request_terminal",
  FAILOVER_TRIGGERED: "proxy_failover_triggered",
  ACCOUNT_COOLDOWN: "proxy_account_cooldown",
  QUOTA_THRESHOLD: "proxy_quota_threshold",
  BUDGET_EXCEEDED: "proxy_budget_exceeded",
} as const;

export type TelemetryEvent =
  (typeof TELEMETRY_EVENTS)[keyof typeof TELEMETRY_EVENTS];

interface QueuedEvent {
  event: string;
  properties: Record<string, unknown>;
  timestamp: string;
  /** Failed send attempts so far; bounds retries of a transiently failed batch. */
  attempts: number;
}

/**
 * The only property keys telemetry may emit — an allowlist, so a caller cannot
 * leak PII or credential material through an undocumented field. A new metric
 * has to be added here (and to the file header) before it can be captured.
 */
const ALLOWED_PROPERTY_KEYS = new Set([
  // Request outcome.
  "provider",
  "model",
  "adapter",
  "status",
  "outcome",
  // Latency.
  "durationMs",
  "firstOutputMs",
  // Token counts.
  "inputTokens",
  "outputTokens",
  "cachedTokens",
  "reasoningTokens",
  // Errors and codex account-pool outcomes.
  "errorCode",
  "accountMode",
  "cooldownMs",
  // Quota and budget thresholds.
  "type",
  "threshold",
  "actual",
  // Canonical PostHog AI observability properties. Content fields are intentionally absent.
  "$ai_trace_id",
  "$ai_session_id",
  "$ai_generation_id",
  "$ai_model",
  "$ai_provider",
  "$ai_latency",
  "$ai_time_to_first_token",
  "$ai_input_tokens",
  "$ai_output_tokens",
  "$ai_total_cost_usd",
  "$ai_http_status",
  "$ai_is_error",
  "$ai_error",
  "$ai_stream",
  "$ai_product",
  // OCX-only privacy-safe dimensions for fleet diagnostics.
  "surface",
  "usageStatus",
  "usageEstimated",
]);

/** Keep only allowlisted metric keys with primitive values, capping string length. */
function sanitizeProperties(
  props: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!props || typeof props !== "object") return {};
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (!ALLOWED_PROPERTY_KEYS.has(key)) continue;
    if (typeof value === "string" && value.length > 200) {
      clean[key] = value.slice(0, 200);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      clean[key] = value;
    } else if (typeof value === "boolean") {
      clean[key] = value;
    } else if (typeof value === "string") {
      clean[key] = value;
    }
  }
  return clean;
}

/** Stable anonymous distinct_id stored on disk — no hostnames, no usernames. */
function loadOrCreateDistinctId(): string {
  const dir = getConfigDir();
  const idPath = join(dir, "telemetry-id.txt");
  try {
    if (existsSync(idPath)) {
      const id = readFileSync(idPath, "utf-8").trim();
      if (id && id.length >= 8) return id;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Random UUID-style id; completely anonymous.
    const id = crypto.randomUUID();
    writeFileSync(idPath, id, { mode: 0o600 });
    try {
      chmodSync(idPath, 0o600);
    } catch {
      /* best-effort */
    }
    return id;
  } catch {
    // Fallback: ephemeral random id if disk is unavailable.
    return crypto.randomUUID();
  }
}

export class PosthogClient {
  private readonly key: string;
  private readonly host: string;
  private readonly distinctId: string;
  private readonly queue: QueuedEvent[] = [];
  private readonly timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  /** Epoch ms before which flushing is suppressed after a transient failure. */
  private retryAfterMs = 0;

  constructor(key: string, host: string = DEFAULT_HOST) {
    this.key = key;
    this.host = host.replace(/\/+$/, "");
    this.distinctId = loadOrCreateDistinctId();
    this.timer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    // Don't keep the process alive just for telemetry flushing.
    this.timer.unref?.();
  }

  /** Fire-and-forget capture. Never throws. */
  capture(event: string, properties?: Record<string, unknown>): void {
    try {
      this.queue.push({
        event,
        properties: sanitizeProperties(properties),
        timestamp: new Date().toISOString(),
        attempts: 0,
      });
      this.enforceQueueBound();
      if (this.queue.length >= MAX_BATCH_SIZE) {
        void this.flush();
      }
    } catch {
      /* swallow — telemetry must never break callers */
    }
  }

  /** Drop the oldest events once the queue exceeds its hard cap. */
  private enforceQueueBound(): void {
    if (this.queue.length > MAX_QUEUE_SIZE) {
      this.queue.splice(0, this.queue.length - MAX_QUEUE_SIZE);
    }
  }

  /**
   * Return a transiently failed batch to the front of the queue so the next
   * flush retries it. Events that exhausted MAX_SEND_ATTEMPTS are dropped, and
   * flushing is delayed with exponential backoff so a failing endpoint is not
   * hammered on every capture.
   */
  private requeue(batch: QueuedEvent[]): void {
    let maxAttempts = 0;
    const retryable: QueuedEvent[] = [];
    for (const queued of batch) {
      queued.attempts += 1;
      if (queued.attempts >= MAX_SEND_ATTEMPTS) continue;
      if (queued.attempts > maxAttempts) maxAttempts = queued.attempts;
      retryable.push(queued);
    }
    if (retryable.length === 0) return;
    this.queue.unshift(...retryable);
    this.enforceQueueBound();
    this.retryAfterMs =
      Date.now() + RETRY_BASE_DELAY_MS * 2 ** (maxAttempts - 1);
  }

  /** Flush pending events to PostHog /batch/ endpoint. */
  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    if (Date.now() < this.retryAfterMs) return;
    this.flushing = true;
    this.retryAfterMs = 0;
    // At most MAX_BATCH_SIZE per request: captures keep arriving while a flush
    // is in flight, and one oversized payload is likelier to be rejected.
    const batch = this.queue.splice(0, MAX_BATCH_SIZE);
    let retryable = false;
    try {
      const body = JSON.stringify({
        api_key: this.key,
        historical_migration: false,
        batch: batch.map((e) => ({
          event: e.event,
          distinct_id: this.distinctId,
          properties: { ...e.properties, $lib: "opencodex-server" },
          timestamp: e.timestamp,
        })),
      });
      const res = await fetch(`${this.host}/batch/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        // Don't hang the proxy on a slow analytics endpoint.
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        void res.body?.cancel().catch(() => {});
        // 429 and 5xx are transient, so the batch is worth retrying. Anything
        // else (bad key, malformed batch) would fail identically forever.
        retryable = res.status === 429 || res.status >= 500;
      }
    } catch {
      /* network errors and timeouts are transient — retry the batch */
      retryable = true;
    } finally {
      if (retryable) this.requeue(batch);
      this.flushing = false;
    }
    // Drain any remainder (or events captured mid-flight) in further batches.
    if (!retryable && this.queue.length > 0) await this.flush();
  }

  /** Flush + stop the timer. Safe to call on shutdown. */
  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    void this.flush();
  }
}

export interface AiGenerationTelemetryInput {
  requestId: string;
  provider: string;
  model: string;
  resolvedModel?: string;
  surface?: string;
  conversationId?: string;
  status: number;
  durationMs: number;
  firstOutputMs?: number;
  errorCode?: string;
  usageStatus: UsageStatus;
  usage?: OcxUsage;
  stream?: boolean;
  requestedServiceTier?: string;
  configuredServiceTier?: string;
  responseServiceTier?: string;
}

function requestIsError(
  entry: Pick<AiGenerationTelemetryInput, "status" | "errorCode">,
): boolean {
  return entry.status >= 400 || Boolean(entry.errorCode);
}

/**
 * Build privacy-safe canonical PostHog AI properties for one terminal gateway request.
 * Prompt/output bodies, raw upstream errors, account identifiers and headers are never accepted.
 */
export function aiGenerationProperties(
  entry: AiGenerationTelemetryInput,
  traceId: string = crypto.randomUUID(),
): Record<string, unknown> {
  const model = entry.resolvedModel?.trim() || entry.model;
  const serviceTier = effectiveServiceTier(entry);
  const cost = estimateRequestCost({
    provider: entry.provider,
    model,
    usage: entry.usage,
    usageStatus: entry.usageStatus,
    ...(serviceTier ? { serviceTier } : {}),
  });
  const isError = requestIsError(entry);
  return {
    $ai_trace_id: traceId,
    $ai_generation_id: entry.requestId,
    ...(entry.conversationId ? { $ai_session_id: entry.conversationId } : {}),
    $ai_model: model,
    $ai_provider: entry.provider,
    $ai_latency: Math.max(0, entry.durationMs) / 1_000,
    ...(entry.firstOutputMs !== undefined
      ? { $ai_time_to_first_token: Math.max(0, entry.firstOutputMs) / 1_000 }
      : {}),
    ...(entry.usage ? {
      $ai_input_tokens: entry.usage.inputTokens,
      $ai_output_tokens: entry.usage.outputTokens,
    } : {}),
    ...(cost ? { $ai_total_cost_usd: cost.cost.total } : {}),
    $ai_http_status: entry.status,
    $ai_is_error: isError,
    ...(entry.errorCode ? { $ai_error: entry.errorCode } : {}),
    ...(entry.stream !== undefined ? { $ai_stream: entry.stream } : {}),
    $ai_product: "opencodex",
    ...(entry.surface ? { surface: entry.surface } : {}),
    usageStatus: entry.usageStatus,
    ...(entry.usage?.estimated !== undefined ? { usageEstimated: entry.usage.estimated } : {}),
  };
}

/** Emit both OCX fleet telemetry and canonical PostHog AI generation telemetry. */
export function captureRequestTelemetry(entry: AiGenerationTelemetryInput): void {
  const client = getServerPosthog();
  if (!client) return;
  try {
    const isError = requestIsError(entry);
    client.capture(TELEMETRY_EVENTS.REQUEST_TERMINAL, {
      provider: entry.provider,
      model: entry.resolvedModel ?? entry.model,
      status: entry.status,
      outcome: isError ? "error" : "success",
      durationMs: entry.durationMs,
      ...(entry.firstOutputMs !== undefined ? { firstOutputMs: entry.firstOutputMs } : {}),
      ...(entry.usage ? {
        inputTokens: entry.usage.inputTokens,
        outputTokens: entry.usage.outputTokens,
      } : {}),
      ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
    });
    client.capture("$ai_generation", aiGenerationProperties(entry));
  } catch {
    // Telemetry is best-effort and must never affect gateway request completion.
  }
}

let cachedClient: PosthogClient | null | undefined;

/**
 * Singleton accessor. Returns a PosthogClient if OCX_POSTHOG_KEY is set, else null.
 * Never throws on misconfiguration.
 */
export function getServerPosthog(): PosthogClient | null {
  if (cachedClient !== undefined) return cachedClient;
  try {
    const key = process.env["OCX_POSTHOG_KEY"]?.trim();
    if (!key) {
      cachedClient = null;
      return null;
    }
    const host = process.env["OCX_POSTHOG_HOST"]?.trim() || DEFAULT_HOST;
    cachedClient = new PosthogClient(key, host);
    return cachedClient;
  } catch {
    cachedClient = null;
    return null;
  }
}

/** Reset the singleton (for tests). */
export function resetServerPosthog(): void {
  if (cachedClient) cachedClient.shutdown();
  cachedClient = undefined;
}
