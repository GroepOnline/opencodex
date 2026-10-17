import { describe, expect, test } from "bun:test";
import {
  createServerSentEventParser,
  decodeServerSentEvents,
  jsonDataPayloads,
  SseFrameTooLargeError,
} from "../src/lib/sse-decoder";

function chunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]) {
  const records = [];
  for await (const record of decodeServerSentEvents(chunkedStream(chunks))) records.push(record);
  return records;
}

async function collectWithComments(chunks: string[]) {
  const records = [];
  for await (const record of decodeServerSentEvents(chunkedStream(chunks), { includeComments: true })) {
    records.push(record);
  }
  return records;
}

describe("text/event-stream decoder", () => {
  test("preserves event state across arbitrary reader chunks", async () => {
    expect(await collect([
      "event: content_",
      "block_delta\n",
      "data: {\"type\":\"content_block_delta\"}\n\n",
    ])).toEqual([{
      event: "content_block_delta",
      data: '{"type":"content_block_delta"}',
    }]);
  });

  test("dispatches the terminal record without a final newline or blank delimiter", async () => {
    expect(await collect([
      "event: message_stop\n",
      'data: {"type":"message_stop"}',
    ])).toEqual([{
      event: "message_stop",
      data: '{"type":"message_stop"}',
    }]);
  });

  test("joins multiline data and accepts CRLF framing", async () => {
    expect(await collect([
      "event: custom\r\ndata: first\r\n",
      "data: second\r\n\r\n",
    ])).toEqual([{ event: "custom", data: "first\nsecond" }]);
  });

  test("yields comment and event records only when comments are opted in", async () => {
    expect(await collectWithComments([
      ": keepalive\n",
      "event: custom\ndata: payload\n\n",
    ])).toEqual([
      { kind: "comment", comment: "keepalive" },
      { kind: "event", event: "custom", data: "payload" },
    ]);
  });

  test("default mode ignores comments and preserves the kind-less record shape", async () => {
    const records = await collect([
      ": keepalive\n",
      "event: custom\ndata: payload\n\n",
    ]);

    expect(records).toEqual([{ event: "custom", data: "payload" }]);
    expect("kind" in records[0]).toBe(false);
  });

  test("accepts bare CR line endings", async () => {
    expect(await collect([
      "event: custom\rdata: first\rdata: second\r\r",
      "data: next\r\r",
    ])).toEqual([
      { event: "custom", data: "first\nsecond" },
      { data: "next" },
    ]);
  });

  test("treats a CRLF split across chunks as a single line terminator", async () => {
    expect(await collect([
      "data: one\r",
      "\ndata: two\r",
      "\n\r",
      "\n",
    ])).toEqual([{ data: "one\ntwo" }]);
  });

  test("reassembles fields and multi-byte characters split across chunk boundaries", async () => {
    const bytes = new TextEncoder().encode('data: {"text":"caf\u00e9 \u2603"}\n\n');
    const split = bytes.indexOf(0xe2) + 1;
    const records = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 3));
        controller.enqueue(bytes.slice(3, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });
    for await (const record of decodeServerSentEvents(stream)) records.push(record);
    expect(records).toEqual([{ data: '{"text":"caf\u00e9 \u2603"}' }]);
  });

  test("accepts data without a space after the colon and strips only one space", async () => {
    expect(await collect([
      "data:{\"a\":1}\n\n",
      "data:  padded\n\n",
      "data\n\n",
    ])).toEqual([
      { data: '{"a":1}' },
      { data: " padded" },
      { data: "" },
    ]);
  });

  test("ignores id and retry fields and reports unknown fields to the observer", () => {
    const unknown: string[] = [];
    const parser = createServerSentEventParser({ onUnknownLine: line => unknown.push(line) });
    const encoder = new TextEncoder();
    expect(parser.push(encoder.encode("id: 7\nretry: 100\ngarbage\ndata: x\n\n"))).toEqual([{ data: "x" }]);
    expect(parser.end()).toEqual([]);
    expect(unknown).toEqual(["garbage"]);
  });

  test("rejects an oversized unterminated line", () => {
    const parser = createServerSentEventParser({ maxFrameLength: 16 });
    const encoder = new TextEncoder();
    expect(parser.push(encoder.encode("data: short\n\n"))).toEqual([{ data: "short" }]);
    expect(() => parser.push(encoder.encode(`data: ${"x".repeat(32)}`))).toThrow(SseFrameTooLargeError);
  });

  test("rejects a frame whose accumulated data lines exceed the cap", () => {
    const parser = createServerSentEventParser({ maxFrameLength: 16 });
    const encoder = new TextEncoder();
    expect(parser.push(encoder.encode("data: 0123456\n"))).toEqual([]);
    expect(() => parser.push(encoder.encode("data: 0123456\n"))).toThrow(SseFrameTooLargeError);
  });

  test("oversized frames reject the async decoder and cancel the source", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${"x".repeat(64)}`));
      },
      cancel() {
        cancelled = true;
      },
    });
    const drain = async () => {
      for await (const _record of decodeServerSentEvents(stream, { maxFrameLength: 32 })) { /* drain */ }
    };
    await expect(drain()).rejects.toBeInstanceOf(SseFrameTooLargeError);
    expect(cancelled).toBe(true);
  });

  test("abort signal settles a pending read", async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({ start() { /* never enqueues */ } });
    const iterator = decodeServerSentEvents(stream, { signal: controller.signal });
    const next = iterator.next();
    controller.abort(new DOMException("stop", "AbortError"));
    expect((await next).done).toBe(true);
  });

  test("jsonDataPayloads splits only when the joined data is not one JSON value", () => {
    expect(jsonDataPayloads('{"a":1}')).toEqual(['{"a":1}']);
    expect(jsonDataPayloads('{"a":\n1}')).toEqual(['{"a":\n1}']);
    expect(jsonDataPayloads('{"a":1}\n{"b":2}')).toEqual(['{"a":1}', '{"b":2}']);
  });
});
