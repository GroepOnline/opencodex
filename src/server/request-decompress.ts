import { gunzipSync, inflateRawSync, inflateSync, zstdDecompressSync } from "node:zlib";

/**
 * Request-body decompression for the /v1/responses data plane.
 *
 * Codex CLI compresses Responses HTTP bodies with zstd when its
 * `enable_request_compression` feature fires (default ON): auth is the codex
 * backend AND the provider is the built-in `openai` id (codex-rs client.rs
 * responses_request_compression). Under Design B injection the provider id IS
 * `openai`, so the HTTP fallback path (WebSocket unavailable) delivers
 * `content-encoding: zstd` bodies that `req.json()` cannot parse.
 */

/**
 * Cap decompressed request bodies (a compressed bomb must not inflate unbounded). Codex compresses
 * EVERY responses request with zstd (no size threshold), and image-heavy histories inflate fast:
 * ~12 full-res screenshots as base64 already cross 64MB decompressed. The proxy is fed by the user's
 * own local Codex over loopback, so the bomb threat is weak; this cap is really an OOM guard. Keep it
 * generous enough that ordinary multi-image sessions decode, while still bounding a runaway body.
 */
export const MAX_DECOMPRESSED_BODY_BYTES = 256 * 1024 * 1024;

/**
 * Cap the INBOUND (still-compressed) wire body too. `decodeRequestBody` bounds decompressed
 * output, but `req.arrayBuffer()` buffered the raw body first with no limit at all — an
 * unbounded memory sink on the authenticated data-plane surface. Any payload that can decode
 * within {@link MAX_DECOMPRESSED_BODY_BYTES} compresses to at most that size plus a few percent
 * of codec overhead, so the same ceiling plus a small margin never rejects a body that could
 * have decoded successfully.
 */
export const MAX_COMPRESSED_BODY_BYTES = MAX_DECOMPRESSED_BODY_BYTES + 1024 * 1024;

export class UnsupportedContentEncodingError extends Error {
  constructor(readonly encoding: string) {
    super(`Unsupported content-encoding: ${encoding}`);
  }
}

export class DecompressedBodyTooLargeError extends Error {
  constructor(readonly bytes: number, limit: number = MAX_DECOMPRESSED_BODY_BYTES) {
    super(`Decompressed request body exceeds ${limit} bytes`);
  }
}

export class CompressedBodyTooLargeError extends Error {
  constructor(readonly bytes: number, limit: number = MAX_COMPRESSED_BODY_BYTES) {
    super(`Compressed request body exceeds ${limit} bytes`);
  }
}

function assertBodySizeWithinLimit(body: Uint8Array, maxBytes: number): Uint8Array {
  if (body.byteLength > maxBytes) throw new DecompressedBodyTooLargeError(body.byteLength, maxBytes);
  return body;
}

function inflateDeflateBody(compressed: Uint8Array<ArrayBuffer>, opts: { maxOutputLength: number }): Uint8Array {
  // HTTP "deflate" appears both zlib-wrapped and raw in the wild (Bun.deflateSync emits raw,
  // which the previous Bun.inflateSync accepted). Try zlib-wrapped first, fall back to raw —
  // but never swallow the size-cap abort.
  try {
    return inflateSync(compressed, opts);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ERR_BUFFER_TOO_LARGE") throw err;
    return inflateRawSync(compressed, opts);
  }
}

export function decodeRequestBody(
  raw: Uint8Array,
  contentEncoding: string | null,
  maxBytes: number = MAX_DECOMPRESSED_BODY_BYTES,
): Uint8Array {
  const encoding = (contentEncoding ?? "").trim().toLowerCase();
  if (encoding === "" || encoding === "identity") return assertBodySizeWithinLimit(raw, maxBytes);
  const compressed = raw as Uint8Array<ArrayBuffer>;
  // `maxOutputLength` makes zlib abort DURING inflation (ERR_BUFFER_TOO_LARGE), so a
  // decompression bomb never allocates beyond the cap — checking after the fact would
  // already have paid the full allocation (review finding, PR #96).
  const opts = { maxOutputLength: maxBytes };
  let decoded: Uint8Array;
  try {
    if (encoding === "zstd") decoded = zstdDecompressSync(compressed, opts);
    else if (encoding === "gzip" || encoding === "x-gzip") decoded = gunzipSync(compressed, opts);
    else if (encoding === "deflate") decoded = inflateDeflateBody(compressed, opts);
    // Multi-codings ("zstd, gzip") and unknown tokens are rejected rather than guessed.
    else throw new UnsupportedContentEncodingError(encoding);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ERR_BUFFER_TOO_LARGE") {
      throw new DecompressedBodyTooLargeError(maxBytes + 1, maxBytes);
    }
    throw err;
  }
  return assertBodySizeWithinLimit(decoded, maxBytes);
}

/** Read the raw wire body with a hard byte cap so oversized payloads abort before full buffering. */
async function readCappedRequestBody(req: Request, maxBytes: number): Promise<Uint8Array> {
  // A declared length over the cap fails fast without reading; the streamed count stays
  // authoritative because the header may be absent or wrong.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new CompressedBodyTooLargeError(declared, maxBytes);
  }
  const stream = req.body;
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new CompressedBodyTooLargeError(total, maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released / cancelled
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** Parse a JSON request body, transparently decoding compressed payloads. */
export async function readJsonRequestBody(req: Request): Promise<unknown> {
  const encoding = req.headers.get("content-encoding");
  const decoded = decodeRequestBody(await readCappedRequestBody(req, MAX_COMPRESSED_BODY_BYTES), encoding);
  return JSON.parse(new TextDecoder().decode(decoded));
}
