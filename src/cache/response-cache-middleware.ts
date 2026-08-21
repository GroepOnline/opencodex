/**
 * Server-side response-cache middleware (Fase D).
 *
 * Wires the per-provider/model KV `ResponseCache` into the three non-streaming POST routes
 * (/v1/responses, /v1/messages, /v1/chat/completions). Streaming requests are never cached:
 * we only store a fully-buffered 2xx JSON body, and we read the original body once to decide.
 *
 * Usage in src/server/index.ts:
 *   await installResponseCache(responseCacheFromConfig(config));
 *   ...
 *   const probe = cacheEnabled ? await probeResponseCache(req, config) : null;
 *   if (probe?.hit) return withCors(probe.hit, req, config);
 *   const workingReq = probe ? probe.request : req;
 *   const response = await handleX(workingReq, ...);
 *   if (probe?.store) probe.store(response);
 *   return withCors(response, ...);
 */

import { ResponseCache, normalizeRequestBody, requestOptsOutOfCache, responseCacheFromConfig, type CacheEntry } from "./kv-cache";
import { routeModel } from "../router";
import type { OcxConfig } from "../types";

let activeCache: ResponseCache | null = null;

/** Install the cache instance for the running server (called once at startServer). */
export async function installResponseCache(config: OcxConfig, configDir?: string): Promise<ResponseCache | null> {
  const cache = responseCacheFromConfig(config, configDir);
  activeCache = cache;
  if (cache.enabled) {
    cache.startSweep();
    console.warn(`[kv-cache] response cache ENABLED (ttl=${cache.ttlMs}ms, max=${cache.maxEntries})`);
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
  /** Store a 2xx non-streaming response into the cache (no-op if not cacheable). */
  store: (response: Response) => void;
}

export type CacheProbe = CacheHit | CacheMiss | null;

/**
 * Probe the cache for a non-streaming request. Returns:
 * - a `CacheHit` (Response) on a cache hit,
 * - a `CacheMiss` carrying a rebuilt Request when the cache is enabled but cold,
 * - null when the cache is disabled / the request is not cacheable.
 */
export async function probeResponseCache(
  req: Request,
  config: OcxConfig,
  endpoint: "responses" | "messages" | "chat-completions",
): Promise<CacheProbe> {
  const cache = activeCache;
  if (!cache || !cache.enabled) return null;
  if (req.method !== "POST") return null;

  // Honor an explicit client-side opt-out (Cache-Control: no-store).
  const cc = req.headers.get("cache-control") ?? "";
  if (/\bno-store\b/i.test(cc)) return null;

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = raw.length ? JSON.parse(raw) : {};
  } catch {
    return null;
  }

  // Never cache streaming requests: we only ever replay fully-buffered bodies, and a
  // streamed SSE body is unsafe to dedupe / replay byte-for-byte.
  if (requestOptsOutOfCache(parsed)) {
    return null;
  }

  const modelId = extractModelId(parsed, endpoint);
  if (!modelId) return null;

  let route: ReturnType<typeof routeModel>;
  try {
    route = routeModel(config, modelId);
  } catch {
    return null;
  }
  if (!route?.providerName) return null;

  const normalized = normalizeRequestBody(parsed);
  if (normalized === null) return null;

  const hit = cache.get(route.providerName, route.modelId, normalized);
  if (hit) {
    const headers = new Headers({
      "content-type": hit.contentType,
      "x-cache": "HIT",
      "cache-control": "no-store",
    });
    console.warn(`[kv-cache] HIT ${ResponseCache.keyPrefix(route.providerName, route.modelId, normalized)} (${hit.body.length}B)`);
    return { hit: new Response(hit.body, { status: 200, headers }) };
  }

  // Rebuild a Request with the re-readable body so the downstream handler can read it again.
  const rebuilt = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: raw,
  });

  const store = (response: Response) => {
    if (response.status < 200 || response.status >= 300) return;
    const ct = response.headers.get("content-type") ?? "application/json";
    if (ct.includes("text/event-stream")) return; // never cache a streamed body
    void response
      .clone()
      .text()
      .then((body) => {
        if (!body) return;
        cache.set(route.providerName, route.modelId, normalized, body, ct);
      })
      .catch(() => {
        /* clone read failure is non-fatal */
      });
  };

  return { miss: true, request: rebuilt, provider: route.providerName, model: route.modelId, normalizedBody: normalized, store };
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

export type { CacheEntry };
