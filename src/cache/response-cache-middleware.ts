/**
 * Server-side response-cache middleware (Fase D).
 *
 * Wires the per-provider/model/endpoint KV `ResponseCache` into the non-stateful non-streaming POST
 * routes (/v1/messages, /v1/chat/completions). `/v1/responses` is deliberately excluded: a cached
 * response id participates in `previous_response_id` continuation state that this body-only cache
 * cannot safely reconstruct. Streaming requests are never
 * cached: we only store a fully-buffered 2xx JSON body, and we read the original body once to
 * decide whether to cache.
 *
 * Usage in src/server/index.ts:
 *   await installResponseCache(responseCacheFromConfig(config));
 *   ...
 *   const probe = cacheEnabled ? await probeResponseCache(req, config, "responses") : null;
 *   if (probe?.hit) return withCors(probe.hit, req, config);
 *   const workingReq = probe ? probe.request : req;
 *   const response = await handleX(workingReq, ...);
 *   if (probe?.store) probe.store(response);
 *   return withCors(response, ...);
 *
 * CRITICAL: every early-return path that has ALREADY consumed `req.text()` must return a
 * `CacheMiss` carrying a REBUILT Request (with the body re-attached), never bare `null`. A bare
 * `null` would hand the downstream handler the original `Request` whose body stream is already
 * drained, causing the handler to receive an empty body. The only paths that may return `null`
 * are the ones that inspect headers/method BEFORE touching the body — there the original Request
 * is still intact and safe to pass through unchanged.
 */

import { createHash } from "node:crypto";
import { ResponseCache, normalizeRequestBody, requestOptsOutOfCache, responseCacheFromConfig } from "./kv-cache";
import { routeModel } from "../router";
import type { OcxConfig } from "../types";

let activeCache: ResponseCache | null = null;

/** Install the cache instance for the running server (called once at startServer). */
export async function installResponseCache(config: OcxConfig, configDir?: string): Promise<ResponseCache | null> {
  const cache = responseCacheFromConfig(config, configDir);
  activeCache = cache;
  if (cache.enabled) {
    cache.startSweep();
    console.warn(`[kv-cache] response cache ENABLED (ttl=${cache.ttlMs}ms, max=${cache.maxEntries}, persist=${cache.persistEnabled})`);
  }
  return cache.enabled ? cache : null;
}

export function getInstalledCache(): ResponseCache | null {
  return activeCache;
}

export interface CacheHit {
  hit: Response;
}

export interface CacheMiss {
  miss: true;
  /** Rebuilt Request with a re-readable body (the original was consumed to compute the key). */
  request: Request;
  provider: string;
  model: string;
  normalizedBody: string;
  endpoint: "responses" | "messages" | "chat-completions";
  /** Store a 2xx non-streaming response into the cache (no-op if not cacheable). */
  store: (response: Response) => void;
}

export type CacheProbe = CacheHit | CacheMiss | null;

/** No-op CacheMiss for the "cache disabled or not cacheable" fast paths (body untouched). */
function disabledProbe(): null {
  return null;
}

/**
 * Build a CacheMiss that does NOT store anything (used when the request is technically cacheable
 * but we cannot route it, or the upstream response is not storable). It still carries a rebuilt
 * Request so the downstream handler gets a re-readable body.
 */
function noStoreMiss(
  rebuilt: Request,
  provider: string | null,
  model: string | null,
  normalized: string,
  endpoint: "responses" | "messages" | "chat-completions",
): CacheMiss {
  return {
    miss: true,
    request: rebuilt,
    provider: provider ?? "",
    model: model ?? "",
    normalizedBody: normalized,
    endpoint,
    store: () => {},
  };
}

/**
 * Probe the cache for a non-streaming request. Returns:
 * - a `CacheHit` (Response) on a cache hit,
 * - a `CacheMiss` carrying a rebuilt Request when the cache is enabled but cold,
 * - null when the cache is disabled / the request is not cacheable AND its body is still intact.
 */
export async function probeResponseCache(
  req: Request,
  config: OcxConfig,
  endpoint: "responses" | "messages" | "chat-completions",
): Promise<CacheProbe> {
  const cache = activeCache;
  // Fast path: cache disabled, or request method not POST. Body untouched, pass through.
  if (!cache || !cache.enabled) return disabledProbe();
  if (req.method !== "POST") return disabledProbe();
  // Responses ids are continuation handles, not replayable payload ids. A cache hit bypasses
  // rememberResponseState(), and persisted cache entries can outlive the 1h continuation store.
  // Until the cache can persist/rebuild provider continuation metadata, fail safe by leaving
  // /v1/responses on its normal stateful path. Body is untouched here.
  if (endpoint === "responses") return disabledProbe();

  // Honor an explicit client-side opt-out (Cache-Control: no-store). Body untouched.
  const cc = req.headers.get("cache-control") ?? "";
  if (/\bno-store\b/i.test(cc)) return disabledProbe();

  // Anything below consumes the body. From here on we MUST return a rebuilt Request one way or
  // another, so the downstream handler never sees a drained stream.
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    // Body already drained and unreadable; nothing we can hand downstream. Signal a miss with a
    // synthetic empty body — the handler will fail the same way it would have reading the stream.
    return noStoreMiss(
      rebuild(req, ""),
      null,
      null,
      "",
      endpoint,
    );
  }

  let parsed: unknown;
  try {
    parsed = raw.length ? JSON.parse(raw) : {};
  } catch {
    return noStoreMiss(rebuild(req, raw), null, null, "", endpoint);
  }

  // Never cache streaming requests: we only ever replay fully-buffered bodies, and a
  // streamed SSE body is unsafe to dedupe / replay byte-for-byte.
  if (requestOptsOutOfCache(parsed)) {
    return noStoreMiss(rebuild(req, raw), null, null, "", endpoint);
  }

  const modelId = extractModelId(parsed, endpoint);
  if (!modelId) return noStoreMiss(rebuild(req, raw), null, null, "", endpoint);

  let route: ReturnType<typeof routeModel>;
  try {
    route = routeModel(config, modelId);
  } catch {
    return noStoreMiss(rebuild(req, raw), null, modelId, "", endpoint);
  }
  if (!route?.providerName) return noStoreMiss(rebuild(req, raw), null, modelId, "", endpoint);

  const normalized = normalizeRequestBody(parsed);
  if (normalized === null) return noStoreMiss(rebuild(req, raw), route.providerName, route.modelId, "", endpoint);

  // Cache entries are scoped to the caller/account/session inputs that can affect routing or
  // upstream semantics. Only the hash participates in the cache material: credentials and account
  // identifiers never reach persistence or logs. A request without any identity material yields a
  // null scope: never pool credential-less callers into a shared bucket (they could replay each
  // other's response bodies). Body stays re-readable via the rebuilt Request.
  const callerScope = cacheCallerScope(req.headers);
  if (callerScope === null) {
    return noStoreMiss(rebuild(req, raw), route.providerName, route.modelId, normalized, endpoint);
  }
  const scopedNormalized = `${callerScope}\0${normalized}`;
  const hit = cache.get(route.providerName, route.modelId, scopedNormalized, endpoint);
  if (hit) {
    const headers = new Headers({
      "content-type": hit.contentType,
      "x-cache": "HIT",
      "cache-control": "no-store",
    });
    console.warn(
      `[kv-cache] HIT ${ResponseCache.keyPrefix(endpoint, route.providerName, route.modelId, scopedNormalized)} (${hit.body.length}B)`,
    );
    return { hit: new Response(hit.body, { status: 200, headers }) };
  }

  // Rebuild a Request with the re-readable body so the downstream handler can read it again.
  const rebuilt = rebuild(req, raw);

  const store = (response: Response) => {
    if (response.status < 200 || response.status >= 300) return;
    const ct = response.headers.get("content-type") ?? "application/json";
    if (ct.includes("text/event-stream")) return; // never cache a streamed body
    // Never cache a response that carries its own content-encoding: the clone().text() below
    // would hand us the still-compressed bytes, and we'd replay garbage to the client.
    if (response.headers.get("content-encoding")) return;
    void response
      .clone()
      .text()
      .then((body) => {
        if (!body) return;
        cache.set(route.providerName, route.modelId, scopedNormalized, body, ct, endpoint);
      })
      .catch(() => {
        /* clone read failure is non-fatal */
      });
  };

  return {
    miss: true,
    request: rebuilt,
    provider: route.providerName,
    model: route.modelId,
    normalizedBody: normalized,
    endpoint,
    store,
  };
}

const CACHE_SCOPE_HEADERS = [
  "authorization",
  "x-opencodex-api-key",
  "x-api-key",
  "chatgpt-account-id",
  "x-codex-installation-id",
  "x-codex-parent-thread-id",
  "session_id",
  "session-id",
  "thread-id",
] as const;

/**
 * Hash identity/affinity inputs so two security principals or sessions never cross-hit.
 * Returns null when the request carries NO identity material: a shared "anonymous" bucket
 * would let credential-less callers replay each other's stored response bodies (CWE-524),
 * so the probe treats a null scope as not-cacheable rather than pooling them together.
 */
function cacheCallerScope(headers: Headers): string | null {
  const material = CACHE_SCOPE_HEADERS
    .map((name) => [name, headers.get(name)?.trim() ?? ""] as const)
    .filter(([, value]) => value.length > 0);
  if (material.length === 0) return null;
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

/** Rebuild a Request carrying `raw` as a re-readable body and the original cancellation signal. */
function rebuild(req: Request, raw: string): Request {
  // The probe already decoded the body via req.text(), so `raw` is plain UTF-8. Drop the
  // original content-encoding/content-length: keeping them makes the downstream JSON reader
  // try to decompress a now-uncompressed body (and mismatches the new byte length).
  const headers = new Headers(req.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Request(req.url, {
    method: req.method,
    headers,
    body: raw,
    signal: req.signal,
  });
}

/** Pull the model id from a parsed request body, per wire protocol. */
function extractModelId(parsed: unknown, endpoint: "responses" | "messages" | "chat-completions"): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.model === "string") return obj.model;
  if (endpoint === "responses" && typeof obj.model === "object" && obj.model !== null) {
    const m = (obj.model as Record<string, unknown>).id;
    if (typeof m === "string") return m;
  }
  return null;
}

/** Operator action: clear the whole response cache (exposed via management API later). */
export function clearResponseCache(): number {
  const cache = activeCache;
  if (!cache) return 0;
  const n = cache.size;
  cache.clear();
  return n;
}
