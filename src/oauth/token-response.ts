/**
 * Validation for fields of an OAuth token-endpoint response.
 *
 * A 200 response with an unexpected shape must fail loudly instead of being persisted as a
 * credential: a missing `access_token` or non-numeric `expires_in` would otherwise store an
 * `undefined` access token and a `NaN` expiry that every later request treats as "not expired".
 * Messages never include any part of the response body.
 */

export class OAuthTokenResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthTokenResponseError";
  }
}

export function requireAccessToken(provider: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OAuthTokenResponseError(`${provider} OAuth response did not include an access token`);
  }
  return value;
}

/**
 * Validate `expires_in` (seconds). Accepts a positive finite number or numeric string. When the
 * field is absent and a fallback is supplied the fallback is used; a present-but-invalid value
 * is always an error.
 */
export function requireExpiresInSeconds(provider: string, value: unknown, fallbackSeconds?: number): number {
  if (value === undefined || value === null) {
    if (fallbackSeconds !== undefined) return fallbackSeconds;
    throw new OAuthTokenResponseError(`${provider} OAuth response did not include expires_in`);
  }
  const seconds = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    throw new OAuthTokenResponseError(`${provider} OAuth response included an invalid expires_in`);
  }
  return seconds;
}

/** A refresh token only when the response carries a non-empty string one. */
export function optionalRefreshToken(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Expiry (epoch ms) for a token lifetime with a refresh skew that can never exceed half the
 * lifetime. A fixed skew larger than a short-lived token's lifetime would mint credentials that
 * are already expired, triggering a refresh on every request.
 */
export function expiryWithSkew(now: number, lifetimeSeconds: number, skewMs: number): number {
  const lifetimeMs = lifetimeSeconds * 1000;
  return now + lifetimeMs - Math.min(skewMs, Math.floor(lifetimeMs / 2));
}
