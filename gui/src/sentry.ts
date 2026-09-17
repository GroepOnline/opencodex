import { sanitizedUrlString } from "./posthog-sanitize";

const ERROR_TYPES = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "AggregateError"]);
const ENVIRONMENTS = new Set(["production", "development", "test", "staging", "preview"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export interface SentryEnvironment {
  VITE_SENTRY_DSN?: unknown;
  VITE_SENTRY_ENVIRONMENT?: unknown;
  VITE_SENTRY_RELEASE?: unknown;
}

export function sentrySettings(env: SentryEnvironment) {
  if (typeof env.VITE_SENTRY_DSN !== "string" || !env.VITE_SENTRY_DSN.trim()) return undefined;
  return {
    dsn: env.VITE_SENTRY_DSN.trim(),
    environment: typeof env.VITE_SENTRY_ENVIRONMENT === "string" && ENVIRONMENTS.has(env.VITE_SENTRY_ENVIRONMENT)
      ? env.VITE_SENTRY_ENVIRONMENT : undefined,
    // Deployment metadata must never become another arbitrary-content channel.
    release: typeof env.VITE_SENTRY_RELEASE === "string" && /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-(?:preview|beta|alpha|rc)\.\d{1,5})?$/.test(env.VITE_SENTRY_RELEASE)
      ? env.VITE_SENTRY_RELEASE : undefined,
  };
}

/** Keep only generated asset locations; no origin, query, hash, or local path survives. */
function filename(value: unknown): string {
  if (typeof value !== "string") return "app:///gui";
  const clean = sanitizedUrlString(value);
  try {
    const url = new URL(clean);
    if (/^\/assets\/[^/]+\.js$/.test(url.pathname) && /^https?:$/.test(url.protocol)) return "app:///gui.js";
  } catch {
    return "app:///gui";
  }
  return "app:///gui";
}

function position(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < 10_000_000 ? value : undefined;
}

/** Rebuild, never redact in place: unknown fields and exception messages are private. */
export function sanitizeSentryEvent(value: unknown, settings?: ReturnType<typeof sentrySettings>) {
  try {
    const event = record(value);
    if (!event || (event.type !== undefined && event.type !== "event")) return null;
    const exceptions = record(event.exception)?.values;
    if (!Array.isArray(exceptions) || !exceptions.length) return null;
    return {
      ...(typeof event.event_id === "string" && /^[a-f0-9]{32}$/.test(event.event_id) ? { event_id: event.event_id } : {}),
      type: undefined,
      platform: "javascript",
      level: "error" as const,
      environment: settings?.environment,
      release: settings?.release,
      tags: { service: "opencodex-gui", repository: "GroepOnline/opencodex", runtime: "browser" },
      exception: { values: exceptions.slice(0, 5).map((value) => {
        const exception = record(value);
        const frames = record(exception?.stacktrace)?.frames;
        return {
          type: typeof exception?.type === "string" && ERROR_TYPES.has(exception.type) ? exception.type : "Error",
          ...(Array.isArray(frames) ? { stacktrace: { frames: frames.slice(-40).map((value) => {
            const frame = record(value);
            return { filename: filename(frame?.filename), lineno: position(frame?.lineno), colno: position(frame?.colno) };
          }) } } : {}),
        };
      }) },
    };
  } catch {
    // Hostile getters/proxies are dropped, never passed through on sanitizer failure.
    return null;
  }
}

/** Defense in depth against attachments, sessions, traces and SDK-added envelope metadata. */
export function sanitizeSentryEnvelope(envelope: unknown, settings?: ReturnType<typeof sentrySettings>) {
  if (!Array.isArray(envelope) || !Array.isArray(envelope[1])) return null;
  const events: Array<[{ type: "event" }, NonNullable<ReturnType<typeof sanitizeSentryEvent>>]> = [];
  for (const item of envelope[1]) {
    if (!Array.isArray(item) || record(item[0])?.type !== "event") continue;
    const event = sanitizeSentryEvent(item[1], settings);
    if (event) events.push([{ type: "event" }, event]);
  }
  if (!events.length) return null;
  const eventId = events[0][1].event_id;
  if (!eventId) return null;
  const headers = { sent_at: new Date().toISOString(), event_id: eventId };
  return [headers, events] as [typeof headers, typeof events];
}
