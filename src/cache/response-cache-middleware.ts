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
import {
  ResponseCache,
  normalizeRequestBody,
  requestOptsOutOfCache,
  responseCacheFromConfig,
} from "./kv-cache";
import { type RouteResult, routeModel } from "../router";
import { isApiAuthRequired } from "../server/auth-cors";
import {
  readTextBodyCapped,
  RequestBodyTooLargeError,
} from "../lib/request-body";
import { MAX_COMPRESSED_BODY_BYTES } from "../server/request-decompress";
import type { OcxConfig } from "../types";

let activeCache: ResponseCache | null = null;

/** Install the cache instance for the running server (called once at startServer). */
export async function installResponseCache(
  config: OcxConfig,
  configDir?: string,
): Promise<ResponseCache | null> {
  const cache = responseCacheFromConfig(config, configDir);
  activeCache = cache;
  if (cache.enabled) {
    cache.startSweep();
    console.warn(
      `[kv-cache] response cache ENABLED (ttl=${cache.ttlMs}ms, max=${cache.maxEntries}, persist=${cache.persistEnabled})`,
    );
  }
  return cache.enabled ? cache : null;
}

export function getInstalledCache(): ResponseCache | null {
  return activeCache;
}

export interface CacheHit {
  hit: Response;
  /** Rebuilt request whose body was consumed while computing the cache key. */
  request: Request;
  /** Cached response body for payload-free trace hashing/counting; never exposed to clients separately. */
  responseBody: string;
  /** Request id that originally populated this entry, when available. */
  sourceTraceId?: string;
  /** Route this hit replayed, so the server can log the served request without re-parsing the body. */
  provider: string;
  model: string;
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
  store: (response: Response, sourceTraceId?: string) => void;
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
  if (!cache || !cache.enabled) return disabledProbe();
  if (isProbeShortCircuit(req, endpoint)) return disabledProbe();

  const body = await readProbeJson(req, endpoint);
  if (body === null || !("raw" in body)) return body;
  const { raw, parsed } = body;

  const prepared = prepareProbeRoute(req, config, endpoint, raw, parsed);
  if (!("normalized" in prepared)) return prepared;
  const { route, normalized } = prepared;

  // Scope cache entries by authenticated identity/session material.
  const callerScope = resolveCallerScope(req, config);
  if (callerScope === null) {
    return noStoreMiss(
      rebuild(req, raw),
      route.providerName,
      route.modelId,
      normalized,
      endpoint,
    );
  }

  const scopedNormalized = `${callerScope}\0${normalized}`;
  const hit = cache.get(
    route.providerName,
    route.modelId,
    scopedNormalized,
    endpoint,
  );
  if (hit) {
    return buildCacheHit(req, raw, route, hit, scopedNormalized, endpoint);
  }

  return probeMiss(
    req,
    raw,
    cache,
    route,
    scopedNormalized,
    normalized,
    endpoint,
  );
}

/**
 * Fast paths where a cache probe cannot run: a non-POST request, the responses
 * endpoint, or an explicit no-store directive. The no-live-cache case is kept
 * inline in `probeResponseCache` so TypeScript narrows `cache` to non-null.
 */
function isProbeShortCircuit(
  req: Request,
  endpoint: "responses" | "messages" | "chat-completions",
): boolean {
  if (req.method !== "POST") return true;
  if (endpoint === "responses") return true;
  const cc = req.headers.get("cache-control") ?? "";
  return /\bno-store\b/i.test(cc);
}

/**
 * Read and JSON-parse the request body for a cache probe, bounded by the
 * compressed-body cap. Returns `{ raw, parsed }` on success or the CacheProbe
 * that ends the probe early: a declared over-cap length fails fast without
 * touching the stream (the original request stays intact for the downstream
 * body reader's own cap error), while any other read/parse failure consumed
 * the body and must hand back a rebuilt Request.
 */
async function readProbeJson(
  req: Request,
  endpoint: "responses" | "messages" | "chat-completions",
): Promise<{ raw: string; parsed: unknown } | CacheProbe> {
  let raw: string;
  try {
    // Bounded read (bounded-runtime follow-up): an uncapped req.text() here let a
    // cache-enabled deployment buffer arbitrary data-plane bodies ahead of the
    // streamed caps the JSON reader enforces downstream.
    raw = await readTextBodyCapped(req, MAX_COMPRESSED_BODY_BYTES);
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError && !req.bodyUsed) {
      // A declared over-cap length failed fast without touching the stream, so
      // the original request is still intact: pass it through and let the
      // downstream body reader surface its own streamed-cap error.
      return disabledProbe();
    }
    return noStoreMiss(rebuild(req, ""), null, null, "", endpoint);
  }

  try {
    return { raw, parsed: raw.length ? JSON.parse(raw) : {} };
  } catch {
    return noStoreMiss(rebuild(req, raw), null, null, "", endpoint);
  }
}

/**
 * Route and normalize a parsed probe body. Returns the resolved route and the
 * normalized body, or the no-store CacheMiss that ends the probe early.
 */
function prepareProbeRoute(
  req: Request,
  config: OcxConfig,
  endpoint: "responses" | "messages" | "chat-completions",
  raw: string,
  parsed: unknown,
): { route: RouteResult; normalized: string } | CacheMiss {
  if (requestOptsOutOfCache(parsed)) {
    return noStoreMiss(rebuild(req, raw), null, null, "", endpoint);
  }

  const modelId = extractModelId(parsed, endpoint);
  if (!modelId) return noStoreMiss(rebuild(req, raw), null, null, "", endpoint);

  let route: RouteResult;
  try {
    route = routeModel(config, modelId);
  } catch {
    return noStoreMiss(rebuild(req, raw), null, modelId, "", endpoint);
  }
  if (!route?.providerName)
    return noStoreMiss(rebuild(req, raw), null, modelId, "", endpoint);

  const normalized = normalizeRequestBody(parsed);
  if (normalized === null)
    return noStoreMiss(
      rebuild(req, raw),
      route.providerName,
      route.modelId,
      "",
      endpoint,
    );

  return { route, normalized };
}

/**
 * Scope cache entries by authenticated identity/session material. Identity-less
 * requests are only pooled on loopback, where admission intentionally treats
 * local traffic as one principal. If alternate wiring reaches this point on an
 * auth-required bind without identity, fail closed (null).
 */
function resolveCallerScope(req: Request, config: OcxConfig): string | null {
  const scope = cacheCallerScope(req.headers);
  if (scope !== null) return scope;
  if (isApiAuthRequired(config)) return null;
  return "loopback-anonymous";
}

/** Build the replayed-response CacheHit for a warm entry. */
function buildCacheHit(
  req: Request,
  raw: string,
  route: RouteResult,
  hit: { body: string; contentType: string; sourceTraceId?: string },
  scopedNormalized: string,
  endpoint: "responses" | "messages" | "chat-completions",
): CacheHit {
  const headers = new Headers({
    "content-type": hit.contentType,
    "x-cache": "HIT",
    "cache-control": "no-store",
  });
  console.warn(
    `[kv-cache] HIT ${ResponseCache.keyPrefix(endpoint, route.providerName, route.modelId, scopedNormalized)} (${hit.body.length}B)`,
  );
  return {
    hit: new Response(hit.body, { status: 200, headers }),
    request: rebuild(req, raw),
    responseBody: hit.body,
    ...(hit.sourceTraceId ? { sourceTraceId: hit.sourceTraceId } : {}),
    provider: route.providerName,
    model: route.modelId,
  };
}

/** Build the cold-path CacheMiss: rebuilt request plus the deferred store hook. */
function probeMiss(
  req: Request,
  raw: string,
  cache: ResponseCache,
  route: RouteResult,
  scopedNormalized: string,
  normalized: string,
  endpoint: "responses" | "messages" | "chat-completions",
): CacheMiss {
  const store = (response: Response, sourceTraceId?: string) => {
    if (response.status < 200 || response.status >= 300) return;
    const ct = response.headers.get("content-type") ?? "application/json";
    if (ct.includes("text/event-stream")) return;
    if (response.headers.get("content-encoding")) return;
    void response
      .clone()
      .text()
      .then((body) => {
        if (!body) return;
        cache.set(
          route.providerName,
          route.modelId,
          scopedNormalized,
          body,
          ct,
          endpoint,
          Date.now(),
          sourceTraceId,
        );
      })
      .catch(() => {
        /* clone read failure is non-fatal */
      });
  };

  return {
    miss: true,
    request: rebuild(req, raw),
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

/** Hash identity/affinity inputs so two authenticated principals or sessions never cross-hit. */
function cacheCallerScope(headers: Headers): string | null {
  const material = CACHE_SCOPE_HEADERS.map(
    (name) => [name, headers.get(name)?.trim() ?? ""] as const,
  ).filter(([, value]) => value.length > 0);
  if (material.length === 0) return null;
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

function rebuild(req: Request, raw: string): Request {
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

function extractModelId(
  parsed: unknown,
  endpoint: "responses" | "messages" | "chat-completions",
): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.model === "string") return obj.model;
  if (
    endpoint === "responses" &&
    typeof obj.model === "object" &&
    obj.model !== null
  ) {
    const m = (obj.model as Record<string, unknown>).id;
    if (typeof m === "string") return m;
  }
  return null;
}

export function clearResponseCache(): number {
  const cache = activeCache;
  if (!cache) return 0;
  const n = cache.size;
  cache.clear();
  return n;
}
