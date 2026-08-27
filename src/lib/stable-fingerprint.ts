import { createHash } from "node:crypto";

/**
 * Deterministic SHA-256 hex for stable identifiers and log labels.
 *
 * This is not a password KDF. Inputs are already-issued account ids, emails, or
 * high-entropy tokens used as identity material. The digest is truncated by
 * callers for short ids. Human passwords must never be passed here.
 */
export function stableSha256Hex(material: string): string {
  // lgtm[js/insufficient-password-hash]
  // codeql[js/insufficient-password-hash]
  return createHash("sha256").update(material).digest("hex");
}
