/** Sentry payloads are rebuilt, never redacted in place or spread from input. */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ERROR_TYPES = new Set([
  "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError",
  "URIError", "EvalError", "AggregateError", "AbortError", "TimeoutError",
]);

export interface SentryMetadata {
  environment?: string;
  release?: string;
}

export function safeSentryMetadata(environment?: string, release?: string): SentryMetadata {
  return {
    // Deployment labels are operator input, but paths, URLs and arbitrary text are not labels.
    environment: environment && /^(production|staging|development|test|preview)$/.test(environment)
      ? environment : undefined,
    release: release && /^(?:v?\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?|[a-f0-9]{7,40})$/.test(release)
      ? release : undefined,
  };
}

function coordinate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value : undefined;
}

export function sanitizeSentryEvent(input: unknown, metadata: SentryMetadata = {}) {
  if (!record(input) || (input.type !== undefined && input.type !== "error")) return null;
  if (!record(input.exception) || !Array.isArray(input.exception.values)) return null;
  const values = input.exception.values.slice(0, 5).filter(record).map(exception => {
    const rawFrames = record(exception.stacktrace) && Array.isArray(exception.stacktrace.frames)
      ? exception.stacktrace.frames : [];
    const frames = rawFrames.slice(-50).filter(record).map(frame => ({
      // Even basenames and function names can contain credentials or user-controlled strings.
      // Preserve stack order and coordinates, never the original filename, source or locals.
      filename: "<redacted>",
      lineno: coordinate(frame.lineno),
      colno: coordinate(frame.colno),
    }));
    return {
      type: typeof exception.type === "string" && ERROR_TYPES.has(exception.type) ? exception.type : "Error",
      value: "Unexpected failure",
      ...(frames.length ? { stacktrace: { frames } } : {}),
    };
  });
  if (!values.length) return null;
  return {
    ...(typeof input.event_id === "string" && /^[a-f0-9]{32}$/.test(input.event_id)
      ? { event_id: input.event_id } : {}),
    type: undefined,
    platform: "javascript",
    level: "error" as const,
    exception: { values },
    ...safeSentryMetadata(metadata.environment, metadata.release),
    tags: { service: "opencodex-server", repository: "GroepOnline/opencodex", runtime: "bun" },
  };
}

/** Do not give the SDK the original Error, its cause, or arbitrary thrown objects. */
export function sentryEventFromError(error: unknown) {
  if (!(error instanceof Error)) {
    return { exception: { values: [{ type: "Error" }] } };
  }
  const frames = (error.stack ?? "").split("\n").slice(1, 51).flatMap(line => {
    const match = /:(\d+):(\d+)\)?\s*$/.exec(line);
    return match ? [{ lineno: Number(match[1]), colno: Number(match[2]) }] : [];
  }).reverse();
  return { exception: { values: [{ type: error.name, stacktrace: { frames } }] } };
}

/** The envelope is another boundary: attachments, sessions and tracing bypass beforeSend. */
export function sanitizeSentryEnvelope(input: unknown, metadata: SentryMetadata) {
  if (!Array.isArray(input) || !Array.isArray(input[1])) return [];
  return input[1].flatMap((item: unknown) => {
    if (!Array.isArray(item) || !record(item[0]) || item[0].type !== "event") return [];
    const event = sanitizeSentryEvent(item[1], metadata);
    return event ? [event] : [];
  });
}
