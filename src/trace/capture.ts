/**
 * Per-request trace capture. A `TraceCapture` hangs off the request log context (`logCtx.trace`) and is
 * also installed in an AsyncLocalStorage so the shared upstream fetch helper can record the final provider
 * wire body without every adapter knowing about tracing.
 *
 * Nothing runs when the mode is `off`. Hashes and counts are computed over the full bodies; only the
 * stored copies are capped, and in `redacted` mode secrets are stripped before anything is written.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, type Hash } from "node:crypto";
import { redactSecretString, redactSecrets } from "../lib/redact";
import { getTraceSettings } from "./settings";
import { writeTrace } from "./store";
import type { TraceMode, UsageTraceMeta } from "./types";

/** Largest inbound body we will buffer for tracing; bigger requests are counted but not read. */
const MAX_INBOUND_READ_BYTES = 8 * 1024 * 1024;
const WALK_NODE_BUDGET = 20_000;
const WALK_MAX_DEPTH = 8;

export interface TraceCapture {
  mode: Exclude<TraceMode, "off">;
  /** Bodies are stored (redacted/full mode and sampled in). */
  persist: boolean;
  maxBodyBytes: number;
  inbound?: string;
  inboundBytes?: number;
  outbound?: string;
  outboundBytes?: number;
  outboundCount: number;
  response: string;
  responseBytes: number;
  responseStoredBytes: number;
  responseTruncated: boolean;
  responseHasher: Hash;
  cacheHit: boolean;
  cacheSourceTraceId?: string;
  done: boolean;
}

const traceStorage = new AsyncLocalStorage<TraceCapture>();

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Keep a prefix within `maxBytes` UTF-8 bytes without splitting a character.
 * Return the retained byte count and whether any input was omitted.
 */
function truncateUtf8(
  text: string,
  maxBytes: number,
): { text: string; bytes: number; truncated: boolean } {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= maxBytes) {
    return { text, bytes: encoded.byteLength, truncated: false };
  }

  let end = Math.max(0, Math.min(maxBytes, encoded.byteLength));
  while (end > 0) {
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
        encoded.subarray(0, end),
      );
      return { text: decoded, bytes: end, truncated: true };
    } catch {
      end -= 1;
    }
  }
  return { text: "", bytes: 0, truncated: true };
}

/**
 * Create a capture from current settings, or undefined when tracing is off.
 * Sampling controls body persistence in redacted/full mode; metadata is still
 * collected for requests that are not sampled.
 */
export function createTraceCapture(): TraceCapture | undefined {
  const settings = getTraceSettings();
  if (settings.mode === "off") return undefined;
  const wantsBodies = settings.mode === "redacted" || settings.mode === "full";
  return {
    mode: settings.mode,
    persist: wantsBodies && Math.random() < settings.sample,
    maxBodyBytes: settings.maxBodyBytes,
    outboundCount: 0,
    response: "",
    responseBytes: 0,
    responseStoredBytes: 0,
    responseTruncated: false,
    responseHasher: createHash("sha256"),
    cacheHit: false,
    done: false,
  };
}

/**
 * Attach a capture and read a clone of `req`, leaving the original body readable.
 * Do nothing when tracing is off. Omit the inbound body and byte count if the
 * declared or observed size exceeds 8 MiB. Failures are swallowed and may leave
 * a capture without inbound data.
 */
export async function beginTrace(
  logCtx: { trace?: TraceCapture },
  req: Request,
): Promise<void> {
  try {
    const trace = createTraceCapture();
    if (!trace) return;
    logCtx.trace = trace;
    const contentLength = req.headers.get("content-length");
    if (contentLength !== null) {
      const declared = Number(contentLength);
      if (Number.isFinite(declared) && declared > MAX_INBOUND_READ_BYTES) return;
    }

    const reader = req.clone().body?.getReader();
    if (!reader) {
      trace.inbound = "";
      trace.inboundBytes = 0;
      return;
    }

    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_INBOUND_READ_BYTES) {
        void reader.cancel().catch(() => {});
        return;
      }
      chunks.push(value);
    }

    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    trace.inbound = new TextDecoder().decode(body);
    trace.inboundBytes = bytes;
  } catch {
    /* tracing is best-effort */
  }
}

/**
 * Run `fn` with `logCtx.trace` available to outbound capture in its async context.
 * Without a capture, call `fn` directly. Return its result unchanged, including
 * promises, and propagate its errors.
 */
export function runWithTrace<T>(
  logCtx: { trace?: TraceCapture },
  fn: () => T,
): T {
  return logCtx.trace ? traceStorage.run(logCtx.trace, fn) : fn();
}

/**
 * Record a string or UTF-8 Uint8Array body in the active, unfinished capture.
 * The last accepted body wins and increments the outbound count, including
 * retries. Ignore other body types, absent/finished captures, and capture errors.
 */
export function noteOutboundRequestBody(body: unknown): void {
  const trace = traceStorage.getStore();
  if (!trace || trace.done) return;
  try {
    let text: string | undefined;
    if (typeof body === "string") text = body;
    else if (body instanceof Uint8Array) text = new TextDecoder().decode(body);
    if (text === undefined) return;
    trace.outbound = text;
    trace.outboundBytes = byteLength(text);
    trace.outboundCount += 1;
  } catch {
    /* ignore */
  }
}

/**
 * Record a proxy response-cache hit without copying the cached response body into trace.sqlite.
 * The full cached body is hashed/count-measured for correlation, while persisted payload capture
 * remains limited to the hit request itself.
 */
export function noteTraceCacheHit(
  trace: TraceCapture | undefined,
  responseBody: string,
  sourceTraceId?: string,
): void {
  if (!trace || trace.done) return;
  try {
    trace.cacheHit = true;
    if (
      typeof sourceTraceId === "string"
      && /^[A-Za-z0-9._:-]{1,128}$/u.test(sourceTraceId)
    ) {
      trace.cacheSourceTraceId = sourceTraceId;
    }
    trace.responseHasher.update(responseBody);
    trace.responseBytes += byteLength(responseBody);
  } catch {
    /* ignore */
  }
}

/**
 * Hash and count one response payload (SSE data block or JSON body) before
 * redaction or truncation. For sampled body capture, retain a UTF-8 byte-capped
 * copy, redacting each payload in redacted mode. Inserted newlines count toward
 * storage limits but not response bytes or hashes. Ignore empty payloads,
 * absent/finished captures, and capture errors.
 */
export function appendTraceResponse(
  trace: TraceCapture | undefined,
  chunk: string,
): void {
  if (!trace || trace.done || !chunk) return;
  try {
    trace.responseHasher.update(chunk);
    trace.responseBytes += byteLength(chunk);
    if (!trace.persist) return;
    const storedChunk = trace.mode === "redacted"
      ? redactBodyForStorage(chunk)
      : chunk;
    const separator = trace.response ? "\n" : "";
    const separatorBytes = separator ? 1 : 0;
    const remaining = trace.maxBodyBytes - trace.responseStoredBytes;
    if (remaining <= separatorBytes) {
      trace.responseTruncated = true;
      return;
    }
    const piece = truncateUtf8(storedChunk, remaining - separatorBytes);
    if (!piece.text) {
      trace.responseTruncated = true;
      return;
    }
    trace.response += separator + piece.text;
    trace.responseStoredBytes += separatorBytes + piece.bytes;
    if (piece.truncated) trace.responseTruncated = true;
  } catch {
    /* ignore */
  }
}

const ATTACHMENT_TYPES = new Set([
  "image",
  "image_url",
  "input_image",
  "input_file",
  "input_audio",
  "document",
  "file",
]);
const TOOL_CALL_TYPES = new Set([
  "function_call",
  "custom_tool_call",
  "tool_use",
  "mcp_call",
  "computer_call",
]);

export interface BodyShape {
  messageCount?: number;
  toolCallCount: number;
  toolDefCount?: number;
  attachmentCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Count top-level messages/input and tool definitions in a parsed request body.
 * Count recognized tool calls and attachments outside tool definitions, visiting
 * up to 20,000 objects/arrays through depth 8; these counts may be partial.
 * Non-object or array roots yield zero calls/attachments and no other counts.
 */
export function shapeOf(parsed: unknown): BodyShape {
  const shape: BodyShape = { toolCallCount: 0, attachmentCount: 0 };
  if (!isRecord(parsed)) return shape;
  if (Array.isArray(parsed.messages))
    shape.messageCount = parsed.messages.length;
  else if (Array.isArray(parsed.input))
    shape.messageCount = parsed.input.length;
  else if (typeof parsed.input === "string") shape.messageCount = 1;
  if (Array.isArray(parsed.tools)) shape.toolDefCount = parsed.tools.length;
  let budget = WALK_NODE_BUDGET;
  const visit = (node: unknown, depth: number): void => {
    if (
      budget <= 0 ||
      depth > WALK_MAX_DEPTH ||
      node === null ||
      typeof node !== "object"
    )
      return;
    budget -= 1;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const rec = node as Record<string, unknown>;
    const type = rec.type;
    if (typeof type === "string") {
      if (ATTACHMENT_TYPES.has(type)) shape.attachmentCount += 1;
      if (TOOL_CALL_TYPES.has(type)) shape.toolCallCount += 1;
    }
    if (Array.isArray(rec.tool_calls))
      shape.toolCallCount += rec.tool_calls.length;
    for (const key of Object.keys(rec)) {
      if (key === "tools") continue; // tool definitions are counted separately
      visit(rec[key], depth + 1);
    }
  };
  visit(parsed, 0);
  return shape;
}

export interface SectionHashes {
  systemHash?: string;
  toolsHash?: string;
  prefixHash?: string;
}

/**
 * Hash JSON-serialized system/instructions, tools, and messages/input excluding
 * the last turn, using the first 32 hexadecimal SHA-256 characters. The prefix
 * hash covers only that turn array, not system or tools; it does not establish
 * provider cache eligibility. Missing sections are omitted; non-object or array
 * roots return {}. JSON serialization errors propagate to the caller.
 */
export function sectionHashes(parsed: unknown): SectionHashes {
  if (!isRecord(parsed)) return {};
  const out: SectionHashes = {};
  const system = parsed.system ?? parsed.instructions;
  if (system !== undefined) out.systemHash = sha(JSON.stringify(system));
  if (Array.isArray(parsed.tools))
    out.toolsHash = sha(JSON.stringify(parsed.tools));
  const turns = Array.isArray(parsed.messages)
    ? parsed.messages
    : Array.isArray(parsed.input)
      ? parsed.input
      : undefined;
  if (turns && turns.length > 0)
    out.prefixHash = sha(JSON.stringify(turns.slice(0, -1)));
  return out;
}

/** Parse JSON, returning undefined for missing or invalid text. */
function tryParse(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Redact known sensitive keys and value patterns in parsed JSON, or known
 * value patterns in non-JSON text. Secrets matching neither remain unchanged.
 */
function redactBodyForStorage(text: string): string {
  const parsed = tryParse(text);
  return parsed !== undefined
    ? JSON.stringify(redactSecrets(parsed))
    : redactSecretString(text);
}

/**
 * Prepare an optional body for storage, redacting in redacted mode before
 * truncating to `max` UTF-8 bytes. An absent body is not marked truncated.
 */
function storableBody(
  text: string | undefined,
  mode: Exclude<TraceMode, "off">,
  max: number,
): { text?: string; truncated: boolean } {
  if (text === undefined) return { truncated: false };
  const out = mode === "redacted" ? redactBodyForStorage(text) : text;
  const bounded = truncateUtf8(out, max);
  return { text: bounded.text, truncated: bounded.truncated };
}

export interface TraceFinalizeInfo {
  conversationId?: string;
  provider?: string;
  model?: string;
  status?: number;
  timestamp: number;
}

export interface TraceFinalizeResult {
  /** Present only when bodies were stored, so the link from usage.jsonl is always resolvable. */
  traceId?: string;
  trace?: UsageTraceMeta;
}

/**
 * Finalize a capture once, returning usage metadata and, on a successful sampled
 * body write, `requestId` as `traceId`. `info.timestamp` is the request start in
 * Unix milliseconds; retention is measured from the write time. Shape counts use
 * parsed inbound data with an outbound fallback; section hashes prefer outbound.
 * Release buffered bodies even on failure. Missing/finished captures and capture
 * errors return {}; a failed store write retains metadata with `stored: false`.
 */
export function finalizeTrace(
  requestId: string,
  logCtx: { trace?: TraceCapture },
  info: TraceFinalizeInfo,
): TraceFinalizeResult {
  const trace = logCtx.trace;
  if (!trace || trace.done) return {};
  trace.done = true;
  try {
    const inboundParsed = tryParse(trace.inbound);
    const outboundParsed = tryParse(trace.outbound);
    const wire = outboundParsed ?? inboundParsed;
    const shape = shapeOf(inboundParsed ?? outboundParsed);
    const hashes = sectionHashes(wire);
    const meta: UsageTraceMeta = {
      mode: trace.mode,
      stored: false,
      ...(trace.inboundBytes !== undefined
        ? { requestBytes: trace.inboundBytes }
        : {}),
      ...(trace.outboundBytes !== undefined
        ? { outboundBytes: trace.outboundBytes }
        : {}),
      ...(trace.responseBytes > 0
        ? { responseBytes: trace.responseBytes }
        : {}),
      ...(shape.messageCount !== undefined
        ? { messageCount: shape.messageCount }
        : {}),
      toolCallCount: shape.toolCallCount,
      ...(shape.toolDefCount !== undefined
        ? { toolDefCount: shape.toolDefCount }
        : {}),
      attachmentCount: shape.attachmentCount,
      ...(trace.outboundCount > 0
        ? { outboundCount: trace.outboundCount }
        : {}),
      ...(trace.cacheHit ? { cacheHit: true } : {}),
      ...(trace.cacheSourceTraceId
        ? { cacheSourceTraceId: trace.cacheSourceTraceId }
        : {}),
      ...(trace.inbound !== undefined
        ? { requestHash: sha(trace.inbound) }
        : {}),
      ...(trace.outbound !== undefined
        ? { outboundHash: sha(trace.outbound) }
        : {}),
      ...(trace.responseBytes > 0
        ? { responseHash: trace.responseHasher.digest("hex").slice(0, 32) }
        : {}),
      ...hashes,
    };
    if (trace.persist) {
      const inbound = storableBody(
        trace.inbound,
        trace.mode,
        trace.maxBodyBytes,
      );
      const outbound = storableBody(
        trace.outbound,
        trace.mode,
        trace.maxBodyBytes,
      );
      const response = storableBody(
        trace.response || undefined,
        trace.mode,
        trace.maxBodyBytes,
      );
      meta.stored = writeTrace({
        traceId: requestId,
        createdAt: info.timestamp,
        mode: trace.mode,
        ...(info.conversationId ? { conversationId: info.conversationId } : {}),
        ...(info.provider ? { provider: info.provider } : {}),
        ...(info.model ? { model: info.model } : {}),
        ...(info.status !== undefined ? { status: info.status } : {}),
        meta: { ...meta, stored: true },
        ...(inbound.text !== undefined ? { inbound: inbound.text } : {}),
        ...(outbound.text !== undefined ? { outbound: outbound.text } : {}),
        ...(response.text !== undefined ? { response: response.text } : {}),
        truncated:
          inbound.truncated ||
          outbound.truncated ||
          response.truncated ||
          trace.responseTruncated,
      });
    }
    return { ...(meta.stored ? { traceId: requestId } : {}), trace: meta };
  } catch {
    return {};
  } finally {
    // Release buffered bodies; the capture is single-use.
    trace.inbound = undefined;
    trace.outbound = undefined;
    trace.response = "";
  }
}
