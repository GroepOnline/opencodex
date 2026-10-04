/** Trace metadata types shared by the usage log and the trace store. No runtime imports. */

export type TraceMode = "off" | "metadata" | "redacted" | "full";

/** Compact per-request trace summary persisted on the usage.jsonl row (no payload content). */
export interface UsageTraceMeta {
  mode: TraceMode;
  /** True when request/response bodies were written to trace.sqlite under `traceId`. */
  stored: boolean;
  requestBytes?: number;
  outboundBytes?: number;
  responseBytes?: number;
  messageCount?: number;
  toolCallCount?: number;
  toolDefCount?: number;
  attachmentCount?: number;
  /** Number of times a provider wire body was sent (retries/continuations). */
  outboundCount?: number;
  /** True when the proxy response cache served this request without an upstream call. */
  cacheHit?: boolean;
  /** Request id that originally populated the response-cache entry, when known. */
  cacheSourceTraceId?: string;
  requestHash?: string;
  outboundHash?: string;
  responseHash?: string;
  /** Section hashes of the final wire body: which part changed between two turns explains a cache miss. */
  systemHash?: string;
  toolsHash?: string;
  /** Hash of the wire body minus its last message/input item: the cacheable prefix. */
  prefixHash?: string;
}

const HASH_RE = /^[0-9a-f]{8,64}$/;
const MODES = new Set<TraceMode>(["off", "metadata", "redacted", "full"]);

function nonNegInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function hash(value: unknown): string | undefined {
  return typeof value === "string" && HASH_RE.test(value) ? value : undefined;
}

/** Whitelist-normalize persisted trace metadata; unknown or malformed fields are dropped. */
export function normalizeUsageTraceMeta(
  raw: unknown,
): UsageTraceMeta | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.mode !== "string" || !MODES.has(r.mode as TraceMode))
    return undefined;
  const out: UsageTraceMeta = {
    mode: r.mode as TraceMode,
    stored: r.stored === true,
  };
  const ints = [
    "requestBytes",
    "outboundBytes",
    "responseBytes",
    "messageCount",
    "toolCallCount",
    "toolDefCount",
    "attachmentCount",
    "outboundCount",
  ] as const;
  for (const key of ints) {
    const v = nonNegInt(r[key]);
    if (v !== undefined) out[key] = v;
  }
  if (r.cacheHit === true) out.cacheHit = true;
  if (
    typeof r.cacheSourceTraceId === "string"
    && /^[A-Za-z0-9._:-]{1,128}$/u.test(r.cacheSourceTraceId)
  ) {
    out.cacheSourceTraceId = r.cacheSourceTraceId;
  }
  const hashes = [
    "requestHash",
    "outboundHash",
    "responseHash",
    "systemHash",
    "toolsHash",
    "prefixHash",
  ] as const;
  for (const key of hashes) {
    const v = hash(r[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}
