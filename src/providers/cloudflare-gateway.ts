/**
 * Cloudflare AI Gateway caches by hashing the full request body, which includes
 * prompt content. Skip that cache unless the operator opts in or already set a
 * per-request cache header.
 *
 * https://developers.cloudflare.com/ai-gateway/features/caching/
 */

const GATEWAY_HOST = "gateway.ai.cloudflare.com";

export function isCloudflareAiGatewayUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname === GATEWAY_HOST;
  } catch {
    return false;
  }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const needle = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === needle);
}

/**
 * Default: `cf-aig-skip-cache: true` so gateway-level caching does not store
 * prompt bodies. `OCX_CF_AIG_CACHE=1` leaves caching to the gateway config.
 * An explicit `cf-aig-skip-cache`, `cf-aig-cache-key`, or `cf-aig-cache-ttl`
 * header already on the request is left untouched.
 */
export function applyCloudflareAiGatewayHeaders(
  headers: Record<string, string>,
  baseUrl: string | undefined,
  env: Record<string, string | undefined> = process.env,
): void {
  if (!isCloudflareAiGatewayUrl(baseUrl)) return;
  if (
    hasHeader(headers, "cf-aig-skip-cache") ||
    hasHeader(headers, "cf-aig-cache-key") ||
    hasHeader(headers, "cf-aig-cache-ttl")
  ) {
    return;
  }
  if (env.OCX_CF_AIG_CACHE === "1") return;
  headers["cf-aig-skip-cache"] = "true";
}
