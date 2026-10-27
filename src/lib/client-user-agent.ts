/**
 * Persistence-safe, deliberately lossy User-Agent identity.
 *
 * Inbound User-Agent is arbitrary client text: it can carry bearer tokens,
 * cookies, query strings, and unknown secret formats. Only a conventional
 * product/version prefix is retained, never the free-form suffix. Unknown
 * formats are omitted rather than risk retaining credentials.
 */
const CLIENT_PRODUCT_VERSION = /^([A-Za-z][A-Za-z0-9._+-]{0,47})\/(v?\d{1,6}(?:\.\d{1,6}){0,5})(?=$|[\s;(),:?&=+\-])/i;
const SENSITIVE_PRODUCT = /(?:auth|bearer|cookie|credential|key|password|secret|session|token|jwt)/i;

export function sanitizeClientUserAgent(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = CLIENT_PRODUCT_VERSION.exec(value.trim());
  if (!match || SENSITIVE_PRODUCT.test(match[1]!)) return undefined;
  return `${match[1]}/${match[2]}`;
}
