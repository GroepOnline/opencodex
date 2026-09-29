import { formatErrorResponse } from "../../bridge";
import { sanitizeCloudflareBlockPayload } from "../../adapters/upstream-http-error";
import {
  resolveClientRetryAfter,
  validateClientRetryAfterHeader,
} from "../../lib/retry-after";

/**
 * Passthrough adapters historically relayed upstream non-2xx bodies verbatim.
 * Codex maps an *empty* body to the literal client string "Unknown error"
 * (UnexpectedResponseError) — issue #452. Only empty bodies need wrapping.
 *
 * Non-empty bodies (including ChatGPT `{detail: ...}` account-model 400s and
 * HTML/text errors) must keep their original bytes and headers so pool-retry
 * activation and client diagnostics stay honest. The one exception is a
 * Cloudflare edge page: its HTML is never provider output, pool-retry decisions
 * are already taken from the raw response upstream of this call, and relaying
 * it verbatim dumps multi-KB markup into the client error.
 *
 * Retry-After is validated independently of the body path:
 * - valid upstream values are preserved
 * - missing/malformed values are replaced when resolveClientRetryAfter yields a value
 * - malformed/expired values are removed when the resolver returns undefined
 *   (e.g. quota-exhausted 429s must not keep junk headers or get the synthetic "2")
 */
export function formatPassthroughUpstreamError(
  status: number,
  bodyText: string,
  options?: {
    statusText?: string;
    headers?: Headers;
    now?: number;
  },
): Response {
  const payload = sanitizeCloudflareBlockPayload(bodyText, status);
  const trimmed = payload.trim();
  // Replacing an HTML edge page with plain text must not leave a text/html type behind.
  const relayContentType = payload !== bodyText ? "text/plain; charset=utf-8" : undefined;
  const now = options?.now ?? Date.now();
  const upstreamRetryAfter = options?.headers?.get("retry-after")?.trim() || undefined;
  const originalValid = validateClientRetryAfterHeader(upstreamRetryAfter, now);
  const resolved = resolveClientRetryAfter({
    status,
    message: trimmed || `Provider error ${status}: (empty body)`,
    upstreamRetryAfter,
    now,
  });

  if (trimmed) {
    const needsSet = resolved !== undefined && upstreamRetryAfter !== resolved;
    const needsDelete = resolved === undefined
      && upstreamRetryAfter !== undefined
      && originalValid === undefined;

    if (!needsSet && !needsDelete) {
      const headers = options?.headers
        ? new Headers(options.headers)
        : new Headers({ "Content-Type": "application/json" });
      if (relayContentType) headers.set("Content-Type", relayContentType);
      return new Response(payload, {
        status,
        ...(options?.statusText ? { statusText: options.statusText } : {}),
        headers,
      });
    }

    const headers = options?.headers
      ? new Headers(options.headers)
      : new Headers({ "Content-Type": "application/json" });
    if (relayContentType) headers.set("Content-Type", relayContentType);
    if (needsSet) headers.set("Retry-After", resolved!);
    else headers.delete("Retry-After");
    return new Response(payload, {
      status,
      ...(options?.statusText ? { statusText: options.statusText } : {}),
      headers,
    });
  }

  const response = formatErrorResponse(
    status,
    "upstream_error",
    `Provider error ${status}: (empty body)`,
    resolved !== undefined ? { retryAfter: resolved } : undefined,
  );
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "application/json");
  if (resolved !== undefined) headers.set("Retry-After", resolved);
  return new Response(response.body, { status: response.status, headers });
}
