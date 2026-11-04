/**
 * Bounded reads for inbound request bodies.
 *
 * `req.json()` buffers the entire body with no size limit. Management-plane
 * bodies are small JSON documents (provider names, key ids, settings), so every
 * inbound JSON read goes through the capped variants here: a declared
 * `content-length` over the cap fails fast without consuming the stream, and
 * the streamed byte count stays authoritative when the header is absent or
 * wrong. The companion {@link readCappedResponseJson} in `bounded-body.ts`
 * covers outbound upstream responses.
 */

/** Default byte cap for inbound JSON request bodies (2 MiB). */
export const JSON_REQUEST_BODY_MAX_BYTES = 2 * 1024 * 1024;

/** Raised when an inbound request body exceeds its byte cap. */
export class RequestBodyTooLargeError extends Error {
  /** HTTP status callers should surface to the client. */
  readonly status = 413;
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`request body exceeded the ${maxBytes}-byte limit`);
    this.name = "RequestBodyTooLargeError";
    this.maxBytes = maxBytes;
  }
}

async function readRequestBodyChunks(
  req: Request,
  maxBytes: number,
): Promise<Uint8Array[]> {
  const body = req.body;
  if (!body) return [];
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return chunks;
      if (!value || value.byteLength === 0) continue;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) throw new RequestBodyTooLargeError(maxBytes);
      chunks.push(value);
    }
  } catch (error) {
    // Abort the remainder instead of buffering it. A broken stream may reject
    // or never settle cancel(); neither may mask the real failure.
    try {
      void reader.cancel(error).catch(() => undefined);
    } catch {
      // Some stream implementations throw synchronously from cancel().
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A pending read can keep the lock briefly while cancel settles.
    }
  }
}

/**
 * Capped replacement for `req.json()`. Throws {@link RequestBodyTooLargeError}
 * once the body is known to exceed `maxBytes` (declared or streamed), and the
 * `SyntaxError` from `JSON.parse` for a malformed body, matching `req.json()`.
 */
export async function readJsonBodyCapped<T = unknown>(
  req: Request,
  maxBytes: number = JSON_REQUEST_BODY_MAX_BYTES,
): Promise<T> {
  // Fail fast on a declared over-cap length without consuming the stream.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RequestBodyTooLargeError(maxBytes);
  }
  const chunks = await readRequestBodyChunks(req, maxBytes);
  const decoder = new TextDecoder();
  let text = "";
  for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
  text += decoder.decode();
  return JSON.parse(text) as T;
}

/**
 * Capped raw-text read for callers that need the undecoded body (for example a
 * cache probe that rebuilds the Request rather than parsing it). Same streamed
 * cap semantics as {@link readJsonBodyCapped}: a declared `content-length` over
 * the cap fails fast without consuming the stream, streamed bytes stay
 * authoritative, and over-cap throws {@link RequestBodyTooLargeError}.
 */
export async function readTextBodyCapped(
  req: Request,
  maxBytes: number = JSON_REQUEST_BODY_MAX_BYTES,
): Promise<string> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RequestBodyTooLargeError(maxBytes);
  }
  const chunks = await readRequestBodyChunks(req, maxBytes);
  const decoder = new TextDecoder();
  let text = "";
  for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
  text += decoder.decode();
  return text;
}

/**
 * Tolerant variant for sites that treated `req.json().catch(() => fallback)` as
 * "no usable body": unreadable or malformed JSON yields `fallback`, but an
 * over-cap body still throws {@link RequestBodyTooLargeError} so callers can
 * answer 413 instead of silently applying the fallback.
 */
export async function readJsonBodyCappedOr<T>(
  req: Request,
  fallback: T,
  maxBytes: number = JSON_REQUEST_BODY_MAX_BYTES,
): Promise<T> {
  try {
    return await readJsonBodyCapped<T>(req, maxBytes);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw error;
    return fallback;
  }
}
