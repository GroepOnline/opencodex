import { createHmac, randomBytes } from "node:crypto";

export type RateLimitPrincipalKind =
  | "admission-key"
  | "management"
  | "remote-address"
  | "anonymous";

const principalBrand: unique symbol = Symbol("opencodex.rate-limit-principal");

/**
 * Opaque process-local principal. The private symbol prevents callers from passing a raw API key,
 * account identifier, or arbitrary string where a keyed fingerprint is required.
 */
export interface RateLimitPrincipal {
  readonly kind: RateLimitPrincipalKind;
  /** Keyed, non-reversible process-local identity. Never persist or log in full. */
  readonly fingerprint: string;
  readonly [principalBrand]: true;
}

const DOMAIN = "opencodex/rate-limit/principal/v1";
const MIN_SECRET_BYTES = 32;
const MAX_PRINCIPAL_BYTES = 16 * 1024;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function validateSecret(secret: Uint8Array): Buffer {
  if (secret.byteLength < MIN_SECRET_BYTES) {
    throw new RangeError(`rate-limit fingerprint secret must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  return Buffer.from(secret);
}

function validatePrincipalValue(value: string): string {
  if (!value) throw new Error("rate-limit principal value must not be empty");
  if (byteLength(value) > MAX_PRINCIPAL_BYTES) {
    throw new RangeError(`rate-limit principal exceeds ${MAX_PRINCIPAL_BYTES} bytes`);
  }
  return value;
}

function createPrincipal(kind: RateLimitPrincipalKind, digest: string): RateLimitPrincipal {
  return Object.freeze({
    kind,
    fingerprint: `${kind}:${digest}`,
    [principalBrand]: true as const,
  });
}

/**
 * HMAC-based principal identity for in-memory rate-limit keys.
 *
 * The secret is process-local by default. Restarting or rotating it intentionally starts
 * fresh buckets. Domain separation includes both the subsystem tag and principal kind, so
 * identities cannot be correlated with fingerprints from another purpose or credential class.
 */
export class PrincipalFingerprinter {
  private readonly secret: Buffer;

  constructor(secret: Uint8Array = randomBytes(MIN_SECRET_BYTES)) {
    this.secret = validateSecret(secret);
  }

  fingerprint(kind: Exclude<RateLimitPrincipalKind, "anonymous">, value: string): RateLimitPrincipal {
    const normalized = validatePrincipalValue(value);
    const digest = createHmac("sha256", this.secret)
      .update(DOMAIN)
      .update("\0")
      .update(kind)
      .update("\0")
      .update(normalized)
      .digest("base64url");
    return createPrincipal(kind, digest);
  }

  admissionKey(value: string): RateLimitPrincipal {
    return this.fingerprint("admission-key", value);
  }

  management(value: string): RateLimitPrincipal {
    return this.fingerprint("management", value);
  }

  remoteAddress(value: string): RateLimitPrincipal {
    return this.fingerprint("remote-address", value);
  }

  anonymous(): RateLimitPrincipal {
    const digest = createHmac("sha256", this.secret)
      .update(DOMAIN)
      .update("\0anonymous\0shared")
      .digest("base64url");
    return createPrincipal("anonymous", digest);
  }
}

/** Process-wide fingerprinter. Its secret is never exported. */
export const rateLimitFingerprinter = new PrincipalFingerprinter();
