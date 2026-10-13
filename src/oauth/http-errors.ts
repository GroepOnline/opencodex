/**
 * Bounded, secret-safe summaries of upstream OAuth error responses.
 *
 * Token-endpoint failures end up in thrown Errors, in the GUI login status and in logs.
 * Echoing the raw upstream body there is unsafe: it is unbounded, it may be an HTML page from
 * an intermediary, and some servers reflect request parameters (authorization codes, refresh
 * tokens) back inside their error text. Only the standard OAuth error fields are surfaced,
 * with control characters stripped, token-shaped runs redacted, and a hard length cap.
 */

const MAX_FIELD_LENGTH = 200;
const MAX_BODY_CHARS = 8192;

/** Long unbroken runs of token alphabet characters (JWTs, opaque access/refresh tokens, codes). */
const TOKEN_LIKE = /[A-Za-z0-9_\-.~+/]{32,}={0,2}/g;

function cleanField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(TOKEN_LIKE, "[redacted]")
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > MAX_FIELD_LENGTH ? `${cleaned.slice(0, MAX_FIELD_LENGTH)}…` : cleaned;
}

/**
 * Extract a short, safe description from an OAuth error body. Understands both the RFC 6749
 * shape (`{ error, error_description }`) and the nested shape (`{ error: { type, message } }`).
 * Returns an empty string when nothing safe can be extracted — never the raw body.
 */
export function oauthErrorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body.slice(0, MAX_BODY_CHARS)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    const record = parsed as Record<string, unknown>;
    const nested =
      record.error && typeof record.error === "object" && !Array.isArray(record.error)
        ? (record.error as Record<string, unknown>)
        : undefined;
    const type = cleanField(nested ? nested.type : record.error);
    const code = cleanField(nested ? nested.code : record.code);
    const description = cleanField(nested ? nested.message : (record.error_description ?? record.message));
    return [type, code, description].filter((part): part is string => !!part).join(": ");
  } catch {
    return "";
  }
}

/** Consume at most 8 KiB, rather than buffering an untrusted upstream error. */
export async function readBoundedOAuthErrorBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let remaining = MAX_BODY_CHARS;
  let text = "";
  try {
    while (remaining > 0) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, remaining);
      text += decoder.decode(chunk, { stream: true });
      remaining -= chunk.byteLength;
    }
    text += decoder.decode();
    return text;
  } catch {
    return "";
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Read an upstream error response and return its safe detail (empty when unavailable). */
export async function readOAuthErrorDetail(response: Response): Promise<string> {
  return oauthErrorDetail(await readBoundedOAuthErrorBody(response));
}
