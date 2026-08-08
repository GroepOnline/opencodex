import { rateLimitFingerprinter, type RateLimitPrincipal } from "../ratelimit";
import type { OcxConfig } from "../types";
import { isDataPlaneAdmissionSecret } from "./auth-cors";

function presentedDataPlaneCredential(req: Request): string | null {
  const actual = req.headers.get("x-opencodex-api-key")?.trim()
    || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim()
    // Anthropic-SDK clients (Claude Code with ANTHROPIC_API_KEY) authenticate via x-api-key.
    || req.headers.get("x-api-key")?.trim();
  return actual || null;
}

/**
 * Resolve an opaque limiter principal without letting unvalidated credentials mint buckets.
 * Raw credentials remain inside the auth boundary; Origin and forwarded-address headers are
 * never identity inputs.
 */
export function resolveDataPlaneRateLimitPrincipal(
  req: Request,
  config: OcxConfig,
  remoteAddress: string | null | undefined,
): RateLimitPrincipal {
  const presented = presentedDataPlaneCredential(req);
  if (presented && isDataPlaneAdmissionSecret(presented, config)) {
    return rateLimitFingerprinter.admissionKey(presented);
  }
  const address = remoteAddress?.trim();
  if (address) return rateLimitFingerprinter.remoteAddress(address);
  return rateLimitFingerprinter.anonymous();
}
