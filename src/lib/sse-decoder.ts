export interface ServerSentEvent {
  event?: string;
  data: string;
}

export type SseRecord =
  | { kind: "event"; event?: string; data: string }
  | { kind: "comment"; comment: string };

/**
 * Shared per-record cap for upstream SSE streams (100 MiB of decoded text). Large enough for
 * inline base64 images in a single frame, small enough that an upstream that never sends a line
 * terminator cannot grow a proxy buffer without bound.
 */
export const MAX_SSE_FRAME_LENGTH = 100 * 1024 * 1024;

/** Thrown when one SSE record (pending line plus accumulated data lines) exceeds the cap. */
export class SseFrameTooLargeError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`upstream SSE frame exceeds ${limit} characters`);
    this.name = "SseFrameTooLargeError";
    this.limit = limit;
  }
}

export interface SseDecoderOptions {
  /** Yield `{ kind: "comment" }` records and tag events with `kind: "event"`. */
  includeComments?: boolean;
  /**
   * Maximum decoded length (UTF-16 code units) of one record: the pending unterminated line plus
   * the data lines accumulated since the last dispatch. Exceeding it throws SseFrameTooLargeError.
   */
  maxFrameLength?: number;
  /** Observes lines whose field is not part of the SSE grammar; they are otherwise ignored. */
  onUnknownLine?: (line: string) => void;
}

/** Push-based decoder for callers that must keep their own reader loop (taps, read-batch logic). */
export interface ServerSentEventParser<R> {
  /** Feed one fetch chunk; returns the records completed by it. */
  push(chunk: Uint8Array): R[];
  /** Flush at EOF, dispatching a final record that lacks its trailing blank line. */
  end(): R[];
}

type SseStreamOptions = SseDecoderOptions & { signal?: AbortSignal };

/**
 * text/event-stream parser per the WHATWG grammar: CRLF, CR, or LF line endings (a CRLF split
 * across chunks counts once), multi-line `data:` joined with "\n", one optional space after the
 * colon, `event:`, and `:` comments. `id:` and `retry:` are accepted and ignored.
 */
export function createServerSentEventParser(
  options: SseDecoderOptions & { includeComments: true },
): ServerSentEventParser<SseRecord>;
export function createServerSentEventParser(
  options?: SseDecoderOptions & { includeComments?: false },
): ServerSentEventParser<ServerSentEvent>;
export function createServerSentEventParser(
  options: SseDecoderOptions = {},
): ServerSentEventParser<ServerSentEvent | SseRecord> {
  type Out = ServerSentEvent | SseRecord;
  const decoder = new TextDecoder();
  const includeComments = options.includeComments === true;
  const maxFrameLength = options.maxFrameLength ?? Number.POSITIVE_INFINITY;
  const onUnknownLine = options.onUnknownLine;
  const lineBreak = /[\r\n]/g;
  let buffer = "";
  // Unterminated tail, kept as parts so a long pending line is not re-concatenated and rescanned
  // on every chunk; it is joined once, when a chunk that can complete it arrives.
  let pending: string[] = [];
  let pendingLength = 0;
  let skipLeadingLineFeed = false;
  let event: string | undefined;
  let dataLines: string[] = [];
  let dataLength = 0;

  const ensureWithinLimit = (length: number) => {
    if (length > maxFrameLength) throw new SseFrameTooLargeError(maxFrameLength);
  };

  const dispatch = (): Out | undefined => {
    if (dataLines.length === 0) {
      event = undefined;
      return undefined;
    }
    const record = { ...(event ? { event } : {}), data: dataLines.join("\n") };
    event = undefined;
    dataLines = [];
    dataLength = 0;
    return includeComments ? { kind: "event", ...record } : record;
  };

  const acceptLine = (line: string): Out | undefined => {
    ensureWithinLimit(dataLength + line.length);
    if (line === "") return dispatch();
    if (line.startsWith(":")) {
      if (!includeComments) return undefined;
      let comment = line.slice(1);
      if (comment.startsWith(" ")) comment = comment.slice(1);
      return { kind: "comment", comment };
    }

    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") event = value;
    else if (field === "data") {
      dataLines.push(value);
      dataLength += value.length + 1;
    } else if (field !== "id" && field !== "retry") onUnknownLine?.(line);
    return undefined;
  };

  const drainLines = (records: Out[]) => {
    let pos = 0;
    while (pos < buffer.length) {
      if (skipLeadingLineFeed) {
        skipLeadingLineFeed = false;
        if (buffer.charCodeAt(pos) === 10) {
          pos++;
          continue;
        }
      }
      lineBreak.lastIndex = pos;
      const match = lineBreak.exec(buffer);
      if (!match) break;
      const end = match.index;
      const line = buffer.slice(pos, end);
      pos = end + 1;
      if (buffer.charCodeAt(end) === 13) {
        // CRLF is one terminator; a CR at the end of the buffer may be followed by LF next chunk.
        if (pos >= buffer.length) skipLeadingLineFeed = true;
        else if (buffer.charCodeAt(pos) === 10) pos++;
      }
      const record = acceptLine(line);
      if (record) records.push(record);
    }
    const tail = pos > 0 ? buffer.slice(pos) : buffer;
    buffer = "";
    pending = tail ? [tail] : [];
    pendingLength = tail.length;
    ensureWithinLimit(dataLength + pendingLength);
  };

  const takePending = (text: string) => {
    buffer = pending.length > 0 ? pending.join("") + text : text;
    pending = [];
    pendingLength = 0;
  };

  return {
    push(chunk) {
      const text = decoder.decode(chunk, { stream: true });
      const records: Out[] = [];
      if (!skipLeadingLineFeed && text.indexOf("\n") < 0 && text.indexOf("\r") < 0) {
        if (text) pending.push(text);
        pendingLength += text.length;
        ensureWithinLimit(dataLength + pendingLength);
        return records;
      }
      takePending(text);
      drainLines(records);
      return records;
    },
    end() {
      takePending(decoder.decode());
      const records: Out[] = [];
      drainLines(records);
      takePending("");
      if (buffer.length > 0) {
        const record = acceptLine(buffer);
        if (record) records.push(record);
      }
      buffer = "";
      skipLeadingLineFeed = false;
      const finalRecord = dispatch();
      if (finalRecord) records.push(finalRecord);
      return records;
    },
  };
}

/**
 * JSON payloads carried by one event's data. Spec framing joins multi-line `data:` with "\n";
 * adapters that historically parsed every `data:` line on its own keep working against upstreams
 * that omit the blank line between events: when the joined text is not one JSON value, each line
 * is returned as its own payload.
 */
export function jsonDataPayloads(data: string): string[] {
  if (!data.includes("\n")) return [data];
  try {
    JSON.parse(data);
    return [data];
  } catch {
    return data.split("\n");
  }
}

/**
 * Decode text/event-stream records across arbitrary fetch chunk boundaries.
 *
 * The final record is dispatched at EOF even when the upstream omits the trailing blank line or
 * final newline. That matters for compatible APIs that place a terminal event in the last bytes of
 * the body: dropping that record turns a successful response into an adapter_eof failure.
 */
export function decodeServerSentEvents(
  source: ReadableStream<Uint8Array>,
  options: SseStreamOptions & { includeComments: true },
): AsyncGenerator<SseRecord>;
export function decodeServerSentEvents(
  source: ReadableStream<Uint8Array>,
  options?: SseStreamOptions & { includeComments?: false },
): AsyncGenerator<ServerSentEvent>;
export async function* decodeServerSentEvents(
  source: ReadableStream<Uint8Array>,
  options?: SseStreamOptions,
): AsyncGenerator<ServerSentEvent | SseRecord> {
  const parser = options?.includeComments === true
    ? createServerSentEventParser({ ...options, includeComments: true })
    : createServerSentEventParser({ ...options, includeComments: false });
  const reader = source.getReader();
  // Prompt cancellation channel: an abort cancels the underlying reader directly, which
  // settles any in-flight read() so a consumer's iterator.return() cannot hang behind an
  // idle upstream (a plain generator return waits for the pending await first).
  const signal = options?.signal;
  const onAbort = () => { reader.cancel(signal?.reason).catch(() => { /* already closed */ }); };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        yield* parser.end();
        break;
      }
      yield* parser.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try { await reader.cancel(); } catch { /* already closed/errored */ }
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}
