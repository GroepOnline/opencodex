import { readBoundedResponseBody } from "../lib/bounded-body";
import { redactSecretString } from "../lib/redact";

const ABSOLUTE_PATH_PATTERN = /(?:\/Users\/[^ "';,]+|\/home\/[^ "';,]+|\/root\/[^ "';,]*|[A-Za-z]:\\Users\\[^ "';,]+)/g;

export function sanitizeUpstreamErrorText(value: string): string {
  return redactSecretString(value).replace(ABSOLUTE_PATH_PATTERN, "[REDACTED_PATH]");
}

export function safeUpstreamErrorString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function parseUpstreamJsonPayload(payloadText: string): unknown | undefined {
  const trimmed = payloadText.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

export async function readDisplaySafeErrorPayloadText(res: Response, signal?: AbortSignal): Promise<string> {
  try {
    const body = await readBoundedResponseBody(res, { signal });
    if (!body.displaySafe) return "";
    return sanitizeCloudflareBlockPayload(body.text, res.status);
  } catch (error) {
    if (signal?.aborted) throw error;
    return "";
  }
}

/**
 * Cloudflare edge pages — WAF blocks, managed challenges, and origin/DNS error
 * pages (1xxx / 52x) — are HTML, not provider JSON. Surfacing them raw leaks a
 * multi-KB HTML dump into client errors (seen as
 * `Error: 403 <!DOCTYPE html>…chefgroep.online`). Detect the page and replace
 * it with a one-line actionable message.
 * Pure functions — no I/O, extracts only the hex Ray ID for correlation.
 *
 * Marker tiers, because the wording must match what the edge actually did:
 * - `CLOUDFLARE_PAGE_MARKERS` (2+ hits) proves the body is a Cloudflare page.
 * - `CLOUDFLARE_BLOCK_MARKERS` (1+ hit) additionally proves the edge *blocked*
 *   the request. A plain error page (521 origin down, 1016 DNS) matches the
 *   first tier only, and calling that "rejected before reaching the provider"
 *   would contradict its own status code.
 */
const CLOUDFLARE_PAGE_MARKERS = [
  "__CF$cv$params",
  "cf-error-details",
  "cdn-cgi/challenge-platform",
  "Attention Required!",
  "Cloudflare Ray ID",
] as const;

const CLOUDFLARE_BLOCK_MARKERS = [
  "Attention Required!",
  "Sorry, you have been blocked",
  "cdn-cgi/challenge-platform",
] as const;

function markerHits(payloadText: string, markers: readonly string[]): number {
  let hits = 0;
  for (const marker of markers) {
    if (payloadText.includes(marker)) hits++;
  }
  return hits;
}

export function extractCloudflareRayId(payloadText: string): string | undefined {
  // `__CF$cv$params={r:'<hex>'}` is unambiguous when present.
  const params = payloadText.match(/__CF\$cv\$params\s*=\s*\{[^}]{0,160}?\br:\s*'([0-9a-f]{16,32})'/i);
  if (params) return params[1];
  // Otherwise scan forward from the visible label: the markup wrapping the ID
  // varies (<strong>, <a>, plain text), but no 16+ hex run sits that close to
  // it unless it *is* the Ray ID.
  const label = payloadText.search(/Cloudflare Ray ID/i);
  if (label >= 0) {
    const hex = payloadText.slice(label, label + 200).match(/\b([0-9a-f]{16,32})\b/i);
    if (hex) return hex[1];
  }
  return undefined;
}

export function extractCloudflareErrorCode(payloadText: string): string | undefined {
  // CF prints both HTTP-shaped codes ("Error 521") and 1xxx zone codes ("Error 1016").
  const labeled = payloadText.match(/\bError\s+(\d{3,4})\b/i) ?? payloadText.match(/error\s+code:?\s*(\d{3,4})/i);
  return labeled?.[1];
}

/** True when the body is a Cloudflare-generated page rather than provider output. */
export function isCloudflareBlockPayload(payloadText: string): boolean {
  return markerHits(payloadText, CLOUDFLARE_PAGE_MARKERS) >= 2;
}

function isCloudflareBlockPage(payloadText: string): boolean {
  return isCloudflareBlockPayload(payloadText)
    && CLOUDFLARE_BLOCK_MARKERS.some(marker => payloadText.includes(marker));
}

export function sanitizeCloudflareBlockPayload(payloadText: string, status: number): string {
  if (!isCloudflareBlockPayload(payloadText)) return payloadText;
  const correlation = `Ray ID: ${extractCloudflareRayId(payloadText) ?? "unknown"}.`;
  if (isCloudflareBlockPage(payloadText)) {
    return (
      `Cloudflare edge block (HTTP ${status}) — the request was rejected before reaching the provider. ` +
      `${correlation} ` +
      `Hint: use the provider subdomain (never the apex), send required CF-Access headers, ` +
      `and look up the Ray ID in the zone WAF/security events.`
    );
  }
  const errorCode = extractCloudflareErrorCode(payloadText);
  return (
    `Cloudflare error page (HTTP ${status}${errorCode ? `, Error ${errorCode}` : ""}) — ` +
    `Cloudflare answered instead of the origin, so the provider error body is unavailable. ` +
    `${correlation} Look up the Ray ID in the zone Analytics/Events to see what the edge returned.`
  );
}

export async function normalizeUpstreamHttpErrorResponse(
  res: Response,
  opts: { signal?: AbortSignal; formatMessage: (payloadText: string) => string | Promise<string> },
): Promise<Response> {
  if (res.ok) return res;
  const payloadText = await readDisplaySafeErrorPayloadText(res, opts.signal);
  const headers = new Headers(res.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(await opts.formatMessage(payloadText), {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}
