/**
 * /api/response-cache — observability + operator action for the Fase D KV response cache.
 *
 * Rides the standard management gate: every /api/* request already passed the independent
 * management-auth gate + origin check before dispatch, so these routes add no auth of their
 * own. The payload is scalar-only (counters + config echoes): no keys, no bodies, no cache-key
 * hashes — consistent with the kv-cache privacy rule (only a short key prefix ever reaches logs).
 */
import { getInstalledCache } from "../../cache/response-cache-middleware";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

export async function handleCacheRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;

  if (url.pathname === "/api/response-cache" && req.method === "GET") {
    const cache = getInstalledCache();
    if (!cache || !cache.enabled) {
      return jsonResponse({ enabled: false }, 200, req, config);
    }
    return jsonResponse({
      enabled: true,
      stats: cache.cacheStats,
      size: cache.size,
      ttlMs: cache.ttlMs,
      maxEntries: cache.maxEntries,
      maxBodyBytes: cache.maxBodyBytes,
      persist: cache.persistEnabled,
    }, 200, req, config);
  }

  if (url.pathname === "/api/response-cache/clear" && req.method === "POST") {
    const cache = getInstalledCache();
    if (!cache || !cache.enabled) {
      return jsonResponse({ success: true, cleared: 0, enabled: false }, 200, req, config);
    }
    const cleared = cache.size;
    cache.clear();
    return jsonResponse({ success: true, cleared, enabled: true }, 200, req, config);
  }

  return null;
}
