import { afterEach, expect, test } from "bun:test";
import { getDebugLogEntries, resetDebugLogBufferForTests } from "../src/lib/debug-log-buffer";
import { resetDebugSettingsForTests, setDebugSettings } from "../src/lib/debug-settings";
import type { RequestLogContext } from "../src/server/request-log";
import { tapAnthropicSseForLog } from "../src/server/claude-messages";

const encoder = new TextEncoder();

function upstreamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function logCtx(): RequestLogContext {
  return { model: "claude-test", provider: "anthropic-native" };
}

afterEach(() => {
  resetDebugSettingsForTests();
  resetDebugLogBufferForTests();
});

test("log tap reads usage from CRLF frames and data without a space after the colon", async () => {
  const chunks = [
    'event: message_start\r\ndata:{"type":"message_start","message":{"usage":{"input_tokens":3}}}\r',
    '\n\r\nevent: message_delta\r\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\r\n\r\n',
    'event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n',
  ];
  const ctx = logCtx();
  const closes: string[] = [];
  const text = await new Response(
    tapAnthropicSseForLog(upstreamOf(chunks), ctx, (_status, meta) => closes.push(meta.closeReason)),
  ).text();

  expect(text).toBe(chunks.join(""));
  expect(ctx.usage).toMatchObject({ inputTokens: 3, outputTokens: 5 });
  expect(closes).toEqual(["terminal"]);
});

test("log tap reads usage from a final frame that lacks its blank-line delimiter", async () => {
  const ctx = logCtx();
  await new Response(tapAnthropicSseForLog(upstreamOf([
    'data: {"type":"message_start","message":{"usage":{"input_tokens":2}}}\n\n',
    'data: {"type":"message_delta","usage":{"output_tokens":4}}',
  ]), ctx, () => {})).text();

  expect(ctx.usage).toMatchObject({ inputTokens: 2, outputTokens: 4 });
});

test("malformed frames are relayed verbatim and debug-logged by length only", async () => {
  setDebugSettings({ debug: true });
  const chunks = [
    "data: {private-frame-body\n\n",
    'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
  ];
  const ctx = logCtx();
  const text = await new Response(tapAnthropicSseForLog(upstreamOf(chunks), ctx, () => {})).text();

  expect(text).toBe(chunks.join(""));
  expect(ctx.usage).toMatchObject({ inputTokens: 1 });
  const lines = getDebugLogEntries().map(entry => entry.line);
  expect(lines.some(line => line.includes("[ocx:frame-drop] anthropic-native") && line.includes("bytes=19"))).toBe(true);
  expect(lines.some(line => line.includes("[ocx:anthropic-native:malformed-frames]") && line.includes('"count":1'))).toBe(true);
  expect(lines.some(line => line.includes("private-frame-body"))).toBe(false);
});
