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
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";

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

export type TelemetryEvent = (typeof TELEMETRY_EVENTS)[keyof typeof TELEMETRY_EVENTS];

interface QueuedEvent {
  event: string;
  properties: Record<string, unknown>;
  timestamp: string;
  /** Failed send attempts so far; bounds retries of a transiently failed batch. */
  attempts: number;
}

/** Keys that are stripped from properties before capture (defense-in-depth). */
const SENSITIVE_KEY_PATTERNS = [
  /^(authorization|api[_-]?key|token|secret|password|cookie)$/i,
  /^(prompt|message|content|body|payload|input|text)$/i,
  /^(header|headers)$/i,
];

/** Strip sensitive-looking keys and cap string values to avoid accidental PII. */
function sanitizeProperties(props: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!props || typeof props !== "object") return {};
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (SENSITIVE_KEY_PATTERNS.some((re) => re.test(key))) continue;
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
    try { chmodSync(idPath, 0o600); } catch { /* best-effort */ }
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
    this.retryAfterMs = Date.now() + RETRY_BASE_DELAY_MS * 2 ** (maxAttempts - 1);
  }

  /** Flush pending events to PostHog /batch/ endpoint. */
  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    if (Date.now() < this.retryAfterMs) return;
    this.flushing = true;
    this.retryAfterMs = 0;
    const batch = this.queue.splice(0, this.queue.length);
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
  }

  /** Flush + stop the timer. Safe to call on shutdown. */
  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    void this.flush();
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
