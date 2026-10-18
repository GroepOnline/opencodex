import { describe, expect, test } from "bun:test";
import {
	BOUNDED_BODY_MAX_BYTES,
	readBoundedErrorText,
	readBoundedResponseBody,
	readCappedResponseArrayBuffer,
	readCappedResponseJson,
	readCappedResponseText,
	UPSTREAM_SUCCESS_BODY_MAX_BYTES,
	UpstreamBodyTooLargeError,
} from "../src/lib/bounded-body";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";

const encoder = new TextEncoder();

function responseFromChunks(...chunks: Uint8Array[]): Response {
	let index = 0;
	return new Response(new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index < chunks.length) controller.enqueue(chunks[index++]);
			else controller.close();
		},
	}));
}

describe("readBoundedResponseBody", () => {
	test("reads multiple chunks and flushes split UTF-8", async () => {
		const bytes = encoder.encode("alpha 한글 🌍");
		const response = responseFromChunks(bytes.subarray(0, 8), bytes.subarray(8, 11), bytes.subarray(11));

		expect(await readBoundedResponseBody(response)).toEqual({
			text: "alpha 한글 🌍",
			truncated: false,
			timedOut: false,
			totalTimedOut: false,
			inactivityTimedOut: false,
			oversized: false,
			displaySafe: true,
		});
	});

	test("empty chunks do not reset the inactivity deadline", async () => {
		let timer: ReturnType<typeof setInterval> | undefined;
		let cancelled = false;
		const response = new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				timer = setInterval(() => controller.enqueue(new Uint8Array()), 3);
			},
			cancel() {
				cancelled = true;
				if (timer) clearInterval(timer);
			},
		}));

		const result = await readBoundedResponseBody(response, { totalTimeoutMs: 100, inactivityTimeoutMs: 15 });
		expect(result.inactivityTimedOut).toBe(true);
		expect(result.totalTimedOut).toBe(false);
		expect(cancelled).toBe(true);
	});

	test("a partial body followed by silence times out and flushes UTF-8", async () => {
		const response = new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([0xe2, 0x82]));
			},
		}));
		const result = await readBoundedResponseBody(response, { totalTimeoutMs: 100, inactivityTimeoutMs: 15 });
		expect(result.text).toBe("�");
		expect(result.truncated).toBe(true);
		expect(result.inactivityTimedOut).toBe(true);
		expect(result.displaySafe).toBe(false);
	});

	test("continuous non-empty trickle still hits the total deadline", async () => {
		let timer: ReturnType<typeof setInterval> | undefined;
		const response = new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				timer = setInterval(() => controller.enqueue(encoder.encode("x")), 4);
			},
			cancel() {
				if (timer) clearInterval(timer);
			},
		}));

		const result = await readBoundedResponseBody(response, { totalTimeoutMs: 25, inactivityTimeoutMs: 15 });
		expect(result.totalTimedOut).toBe(true);
		expect(result.inactivityTimedOut).toBe(false);
		expect(result.text.length).toBeGreaterThan(0);
		expect(result.displaySafe).toBe(false);
	});

	test("accepts exactly the cap when EOF follows", async () => {
		const response = responseFromChunks(new Uint8Array(BOUNDED_BODY_MAX_BYTES).fill(0x61));
		const result = await readBoundedResponseBody(response);
		expect(result.text.length).toBe(BOUNDED_BODY_MAX_BYTES);
		expect(result.truncated).toBe(false);
		expect(result.oversized).toBe(false);
	});

	test("one oversized chunk is discarded and cancels the reader", async () => {
		let cancelled = false;
		const response = new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(BOUNDED_BODY_MAX_BYTES + 1).fill(0x61));
			},
			cancel() { cancelled = true; },
		}));
		const result = await readBoundedResponseBody(response);
		expect(result.text).toBe("");
		expect(result.oversized).toBe(true);
		expect(result.displaySafe).toBe(false);
		expect(cancelled).toBe(true);
	});

	test("parent abort rejects with the exact reason object", async () => {
		const controller = new AbortController();
		const reason = { code: "parent-stopped" };
		const response = new Response(new ReadableStream<Uint8Array>({}));
		const reading = readBoundedResponseBody(response, {
			signal: controller.signal,
			totalTimeoutMs: 100,
			inactivityTimeoutMs: 100,
		});
		controller.abort(reason);
		try {
			await reading;
			expect.unreachable("read should reject");
		} catch (error) {
			expect(error).toBe(reason);
		}
	});

	test("parent abort wins when EOF settles in the same turn", async () => {
		const parent = new AbortController();
		const reason = new Error("same-turn cancel");
		const response = new Response(new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.close();
				parent.abort(reason);
			},
		}));

		let caught: unknown;
		try {
			await readBoundedResponseBody(response, {
				signal: parent.signal,
				totalTimeoutMs: 100,
				inactivityTimeoutMs: 100,
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(reason);
	});

	test("cancel rejection is observed rather than becoming unhandled", async () => {
		const unhandled: unknown[] = [];
		const listener = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", listener);
		try {
			const response = new Response(new ReadableStream<Uint8Array>({
				cancel() { return Promise.reject(new Error("cancel failed")); },
			}));
			const result = await readBoundedResponseBody(response, { totalTimeoutMs: 10, inactivityTimeoutMs: 10 });
			expect(result.timedOut).toBe(true);
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", listener);
		}
	});

	test("consumes the original response body without cloning", async () => {
		const response = responseFromChunks(encoder.encode("original"));
		let cloneCalls = 0;
		response.clone = () => {
			cloneCalls++;
			throw new Error("must not clone");
		};

		const result = await readBoundedResponseBody(response);
		expect(result.text).toBe("original");
		expect(response.bodyUsed).toBe(true);
		expect(cloneCalls).toBe(0);
	});
});

/**
 * Pull-driven body that re-enqueues one shared chunk `count` times, so a large
 * logical body costs one chunk of memory. `pulls` shows how much was consumed.
 */
function countingBody(chunk: Uint8Array, count: number) {
	const state = { pulls: 0, cancelled: false };
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (state.pulls >= count) {
				controller.close();
				return;
			}
			state.pulls++;
			controller.enqueue(chunk);
		},
		cancel() {
			state.cancelled = true;
		},
	}, { highWaterMark: 0 });
	return { stream, state };
}

describe("readBoundedErrorText", () => {
	test("returns display-safe error text", async () => {
		expect(await readBoundedErrorText(responseFromChunks(encoder.encode('{"error":"x"}')))).toBe('{"error":"x"}');
	});

	test("an error body larger than the cap is cut off without reading it all", async () => {
		const chunk = new Uint8Array(16 * 1024).fill(0x61);
		const totalChunks = 256; // 4 MiB logical body
		const { stream, state } = countingBody(chunk, totalChunks);

		expect(await readBoundedErrorText(new Response(stream))).toBeUndefined();
		// Four chunks fill the cap and the fifth crosses it. Allow one read-ahead.
		expect(state.pulls).toBeLessThanOrEqual(BOUNDED_BODY_MAX_BYTES / chunk.byteLength + 2);
		expect(state.pulls).toBeLessThan(totalChunks);
		expect(state.cancelled).toBe(true);
	});

	test("an aborted read resolves to undefined instead of throwing", async () => {
		const controller = new AbortController();
		const reading = readBoundedErrorText(new Response(new ReadableStream<Uint8Array>({})), controller.signal);
		controller.abort(new Error("client gone"));
		expect(await reading).toBeUndefined();
	});
});

describe("capped upstream success bodies", () => {
	test("the default cap is 64 MiB", () => {
		expect(UPSTREAM_SUCCESS_BODY_MAX_BYTES).toBe(64 * 1024 * 1024);
	});

	test("reads text and JSON at exactly the cap", async () => {
		const json = JSON.stringify({ ok: "한글" });
		const bytes = encoder.encode(json);
		expect(await readCappedResponseText(responseFromChunks(bytes.subarray(0, 9), bytes.subarray(9)), { maxBytes: bytes.byteLength })).toBe(json);
		expect(await readCappedResponseJson(responseFromChunks(bytes), { maxBytes: bytes.byteLength })).toEqual({ ok: "한글" });
		const buffer = await readCappedResponseArrayBuffer(responseFromChunks(bytes.subarray(0, 3), bytes.subarray(3)), { maxBytes: bytes.byteLength });
		expect(new Uint8Array(buffer)).toEqual(bytes);
	});

	test("malformed JSON still rejects with SyntaxError", async () => {
		await expect(readCappedResponseJson(responseFromChunks(encoder.encode("not json")))).rejects.toBeInstanceOf(SyntaxError);
	});

	test("an oversized streamed body fails with a 502 error and cancels the stream", async () => {
		const chunk = new Uint8Array(512).fill(0x61);
		const { stream, state } = countingBody(chunk, 100);
		let caught: unknown;
		try {
			await readCappedResponseText(new Response(stream), { maxBytes: 1024 });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(UpstreamBodyTooLargeError);
		expect((caught as UpstreamBodyTooLargeError).status).toBe(502);
		expect((caught as UpstreamBodyTooLargeError).maxBytes).toBe(1024);
		// Two 512-byte chunks fit; the third crosses the cap. Allow one read-ahead.
		expect(state.pulls).toBeLessThanOrEqual(4);
		expect(state.cancelled).toBe(true);
	});

	test("a declared Content-Length over the cap fails before reading", async () => {
		const { stream, state } = countingBody(new Uint8Array(8), 10);
		const response = {
			headers: new Headers({ "content-length": "2048" }),
			body: stream,
		} as unknown as Response;
		await expect(readCappedResponseJson(response, { maxBytes: 1024 })).rejects.toBeInstanceOf(UpstreamBodyTooLargeError);
		expect(state.pulls).toBe(0);
		expect(state.cancelled).toBe(true);
	});

	test("parent abort rejects with the exact reason object and cancels the body", async () => {
		const controller = new AbortController();
		const reason = { code: "client-closed" };
		let cancelled = false;
		const response = new Response(new ReadableStream<Uint8Array>({
			cancel() { cancelled = true; },
		}));
		const reading = readCappedResponseText(response, { signal: controller.signal });
		controller.abort(reason);
		let caught: unknown;
		try {
			await reading;
		} catch (error) {
			caught = error;
		}
		expect(caught).toBe(reason);
		expect(cancelled).toBe(true);
	});

	test("adapter parseResponse surfaces an oversized success JSON as UpstreamBodyTooLargeError", async () => {
		const adapter = createOpenAIChatAdapter({
			adapter: "openai-chat",
			baseUrl: "https://provider.example/v1",
			apiKey: "sk-test",
		});
		const { stream, state } = countingBody(new Uint8Array(8), 10);
		const response = {
			headers: new Headers({
				"content-type": "application/json",
				"content-length": String(UPSTREAM_SUCCESS_BODY_MAX_BYTES + 1),
			}),
			body: stream,
		} as unknown as Response;
		await expect(adapter.parseResponse!(response)).rejects.toBeInstanceOf(UpstreamBodyTooLargeError);
		expect(state.pulls).toBe(0);
	});
});
