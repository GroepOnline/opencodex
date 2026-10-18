/** Maximum number of response-body bytes that may be retained for an error. */
export const BOUNDED_BODY_MAX_BYTES = 65_536;

/** Default wall-clock and continuous-silence deadlines. */
export const BOUNDED_BODY_TIMEOUT_MS = 5_000;

export interface BoundedBodyOptions {
	/** Abort the read with this signal. Its reason is rethrown by identity. */
	signal?: AbortSignal;
	/** Total wall-clock deadline. Exposed for focused tests. */
	totalTimeoutMs?: number;
	/** Deadline between non-empty raw chunks. Exposed for focused tests. */
	inactivityTimeoutMs?: number;
}

export interface BoundedBodyResult {
	/** UTF-8 text retained from the response. Empty when the size limit was exceeded. */
	text: string;
	/** True when EOF was not observed. */
	truncated: boolean;
	/** True for either total-deadline or inactivity-deadline expiry. */
	timedOut: boolean;
	/** Distinguishes the wall-clock deadline from an inactivity deadline. */
	totalTimedOut: boolean;
	/** True only when continuous inactivity caused the timeout. */
	inactivityTimedOut: boolean;
	/** True when the body was observed to exceed the byte cap. */
	oversized: boolean;
	/** False means callers should use a status-only fallback, not `text`. */
	displaySafe: boolean;
}

const TOTAL_TIMEOUT = Symbol("bounded body total timeout");
const INACTIVITY_TIMEOUT = Symbol("bounded body inactivity timeout");

function timeoutPromise(ms: number, value: symbol): { promise: Promise<symbol>; clear: () => void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const promise = new Promise<symbol>((resolve) => {
		timer = setTimeout(() => resolve(value), Math.max(0, ms));
	});
	return {
		promise,
		clear: () => {
			if (timer !== undefined) clearTimeout(timer);
		},
	};
}

function cancelWithoutWaiting(reader: ReadableStreamDefaultReader<Uint8Array>, reason?: unknown): void {
	// A hostile/broken stream may reject or never settle cancel(). Neither should
	// escape as an unhandled rejection or extend this primitive's own deadline.
	try {
		void reader.cancel(reason).catch(() => undefined);
	} catch {
		// Some stream implementations throw synchronously from cancel().
	}
}

function decodeUtf8(chunks: readonly Uint8Array[]): string {
	const decoder = new TextDecoder();
	let text = "";
	for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
	// Flush an incomplete trailing UTF-8 sequence deterministically.
	text += decoder.decode();
	return text;
}

/**
 * Consume the original response body under strict memory and time bounds.
 *
 * This deliberately calls `getReader()` on `response.body`: it never clones or
 * tees the response. Once an over-limit byte is observed, all retained raw data
 * is discarded so an untrusted prefix can never become a client-facing error.
 */
export async function readBoundedResponseBody(
	response: Response,
	options: BoundedBodyOptions = {},
): Promise<BoundedBodyResult> {
	const signal = options.signal;
	if (signal?.aborted) throw signal.reason;

	const body = response.body;
	if (!body) {
		return {
			text: "",
			truncated: false,
			timedOut: false,
			totalTimedOut: false,
			inactivityTimedOut: false,
			oversized: false,
			displaySafe: true,
		};
	}

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let retainedBytes = 0;
	let mustCancel = false;
	let cancelReason: unknown;
	const total = timeoutPromise(options.totalTimeoutMs ?? BOUNDED_BODY_TIMEOUT_MS, TOTAL_TIMEOUT);
	let inactivity = timeoutPromise(
		options.inactivityTimeoutMs ?? BOUNDED_BODY_TIMEOUT_MS,
		INACTIVITY_TIMEOUT,
	);

	let rejectForAbort: ((reason: unknown) => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectForAbort = reject;
	});
	const onAbort = () => rejectForAbort?.(signal?.reason);
	signal?.addEventListener("abort", onAbort, { once: true });
	// Close the narrow race between the preflight check and listener install.
	if (signal?.aborted) onAbort();

	try {
		while (true) {
			// Attach a rejection handler before racing. If a deadline wins and
			// cancellation later rejects this read, it remains observed.
			const read = reader.read();
			void read.catch(() => undefined);
			const outcome = await Promise.race([read, total.promise, inactivity.promise, aborted]);
			// Cancellation owns the body lifetime even when EOF/readability settles in
			// the same turn. Promise.race otherwise lets array order hide the abort.
			if (signal?.aborted) {
				mustCancel = true;
				cancelReason = signal.reason;
				throw signal.reason;
			}

			if (outcome === TOTAL_TIMEOUT || outcome === INACTIVITY_TIMEOUT) {
				mustCancel = true;
				cancelReason = new DOMException(
					outcome === TOTAL_TIMEOUT ? "Error body total timeout" : "Error body inactivity timeout",
					"TimeoutError",
				);
				return {
					text: decodeUtf8(chunks),
					truncated: true,
					timedOut: true,
					totalTimedOut: outcome === TOTAL_TIMEOUT,
					inactivityTimedOut: outcome === INACTIVITY_TIMEOUT,
					oversized: false,
					displaySafe: false,
				};
			}

			const { value, done } = outcome as ReadableStreamReadResult<Uint8Array>;
			if (done) {
				return {
					text: decodeUtf8(chunks),
					truncated: false,
					timedOut: false,
					totalTimedOut: false,
					inactivityTimedOut: false,
					oversized: false,
					displaySafe: true,
				};
			}

			if (!value || value.byteLength === 0) continue;

			inactivity.clear();
			inactivity = timeoutPromise(
				options.inactivityTimeoutMs ?? BOUNDED_BODY_TIMEOUT_MS,
				INACTIVITY_TIMEOUT,
			);

			if (value.byteLength > BOUNDED_BODY_MAX_BYTES - retainedBytes) {
				mustCancel = true;
				cancelReason = new DOMException("Error body size limit reached", "QuotaExceededError");
				chunks.length = 0;
				retainedBytes = 0;
				return {
					text: "",
					truncated: true,
					timedOut: false,
					totalTimedOut: false,
					inactivityTimedOut: false,
					oversized: true,
					displaySafe: false,
				};
			}

			chunks.push(value);
			retainedBytes += value.byteLength;
		}
	} catch (error) {
		mustCancel = true;
		cancelReason = error;
		throw error;
	} finally {
		total.clear();
		inactivity.clear();
		signal?.removeEventListener("abort", onAbort);
		if (mustCancel) cancelWithoutWaiting(reader, cancelReason);
		try {
			reader.releaseLock();
		} catch {
			// A pending read can keep the lock briefly while cancel settles.
		}
	}
}

/**
 * Error-body convenience over {@link readBoundedResponseBody}.
 *
 * Returns the bounded text when it is display-safe, and `undefined` when the
 * body was oversized, timed out, failed, or the read was aborted. It never
 * throws, so callers keep their existing status-only fallback; an abort of
 * `signal` still stops the read (and cancels the body) immediately.
 */
export async function readBoundedErrorText(
	response: Response,
	signal?: AbortSignal,
): Promise<string | undefined> {
	try {
		const body = await readBoundedResponseBody(response, { signal });
		return body.displaySafe ? body.text : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Upper bound for buffering a complete, non-streaming upstream success body.
 *
 * Non-streaming model responses can legitimately be large (long completions,
 * inline base64 media, big tool-call arguments), so this is deliberately far
 * above {@link BOUNDED_BODY_MAX_BYTES}. It is not a product limit; it only stops
 * a misbehaving upstream from making the proxy buffer an unbounded body.
 */
export const UPSTREAM_SUCCESS_BODY_MAX_BYTES = 64 * 1024 * 1024;

/** Raised when an upstream body exceeds its byte cap. Callers surface `status`. */
export class UpstreamBodyTooLargeError extends Error {
	/** The upstream misbehaved, not the client: report it as a bad gateway. */
	readonly status = 502;
	readonly maxBytes: number;

	constructor(maxBytes: number) {
		super(`upstream response body exceeded the ${maxBytes}-byte limit`);
		this.name = "UpstreamBodyTooLargeError";
		this.maxBytes = maxBytes;
	}
}

export interface CappedBodyOptions {
	/** Abort the read with this signal. Its reason is rethrown by identity. */
	signal?: AbortSignal;
	/** Byte cap. Defaults to {@link UPSTREAM_SUCCESS_BODY_MAX_BYTES}. */
	maxBytes?: number;
}

async function readCappedChunks(
	response: Response,
	options: CappedBodyOptions,
): Promise<{ chunks: Uint8Array[]; byteLength: number }> {
	const signal = options.signal;
	const maxBytes = options.maxBytes ?? UPSTREAM_SUCCESS_BODY_MAX_BYTES;
	if (signal?.aborted) throw signal.reason;

	const body = response.body;
	if (!body) return { chunks: [], byteLength: 0 };

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;

	let rejectForAbort: ((reason: unknown) => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectForAbort = reject;
	});
	void aborted.catch(() => undefined);
	const onAbort = () => rejectForAbort?.(signal?.reason);
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) onAbort();

	try {
		// A declared length over the cap fails fast without reading. The streamed
		// count below stays authoritative: the header may be absent or wrong.
		const declared = Number(response.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > maxBytes) throw new UpstreamBodyTooLargeError(maxBytes);

		while (true) {
			const read = reader.read();
			void read.catch(() => undefined);
			const outcome = await Promise.race([read, aborted]);
			if (signal?.aborted) throw signal.reason;
			if (outcome.done) return { chunks, byteLength };
			const value = outcome.value;
			if (!value || value.byteLength === 0) continue;
			if (value.byteLength > maxBytes - byteLength) throw new UpstreamBodyTooLargeError(maxBytes);
			chunks.push(value);
			byteLength += value.byteLength;
		}
	} catch (error) {
		chunks.length = 0;
		cancelWithoutWaiting(reader, error);
		throw error;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		try {
			reader.releaseLock();
		} catch {
			// A pending read can keep the lock briefly while cancel settles.
		}
	}
}

/**
 * Capped replacement for `response.arrayBuffer()` on a non-streaming upstream
 * success body. Rejects with {@link UpstreamBodyTooLargeError} once the body is
 * known to exceed the cap, cancelling it instead of buffering the remainder.
 */
export async function readCappedResponseArrayBuffer(
	response: Response,
	options: CappedBodyOptions = {},
): Promise<ArrayBuffer> {
	const { chunks, byteLength } = await readCappedChunks(response, options);
	const out = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out.buffer;
}

/** Capped replacement for `response.text()`; see {@link readCappedResponseArrayBuffer}. */
export async function readCappedResponseText(
	response: Response,
	options: CappedBodyOptions = {},
): Promise<string> {
	const { chunks } = await readCappedChunks(response, options);
	return decodeUtf8(chunks);
}

/**
 * Capped replacement for `response.json()`. A malformed body still rejects with
 * the `SyntaxError` from `JSON.parse`, matching `response.json()`.
 */
export async function readCappedResponseJson<T = unknown>(
	response: Response,
	options: CappedBodyOptions = {},
): Promise<T> {
	return JSON.parse(await readCappedResponseText(response, options)) as T;
}
