import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { chatToolNameCodec } from "../src/adapters/openai-chat-tool-names";
import { buildToolBridgeMaps } from "../src/server/responses/collaboration";
import type { AdapterEvent, OcxParsedRequest } from "../src/types";

const longName = `search_${"a".repeat(80)}`;
const adapter = () => createOpenAIChatAdapter({ adapter: "openai-chat", baseUrl: "https://example.test/v1" });
function request(namespace?: string): OcxParsedRequest {
  return {
    modelId: "test", stream: true,
    options: { toolChoice: { name: namespace ? `${namespace}.${longName}` : longName } },
    context: {
      tools: [{ name: longName, namespace, description: "test", parameters: { type: "object" } }],
      messages: [
        { role: "assistant", timestamp: 0, content: [{ type: "toolCall", id: "call_original", name: longName, namespace, arguments: { name: longName } }] },
        { role: "toolResult", timestamp: 0, toolCallId: "call_original", toolName: longName, toolNamespace: namespace, content: "ok", isError: false },
      ],
    },
  };
}

describe("Chat tool-name codec", () => {
  test("preserves 64 valid ASCII characters and aliases 65, empty and invalid names", () => {
    const names = ["a".repeat(64), "a".repeat(65), "with.dot/space é", "", "9-valid_name"];
    const codec = chatToolNameCodec(names);
    expect(codec.toWire(names[0])).toBe(names[0]);
    expect(codec.toWire(names[4])).toBe(names[4]);
    for (const name of names) {
      expect(codec.toWire(name)).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(codec.fromWire(codec.toWire(name))).toBe(name);
    }
    expect(codec.fromWire("unknown_tool")).toBe("unknown_tool");
  });

  test("separates identical cleaned prefixes and reserves conforming originals regardless of order", () => {
    const other = `${longName}b`;
    const initial = chatToolNameCodec([longName]).toWire(longName);
    const second = chatToolNameCodec([longName, initial]).toWire(longName);
    // Force two consecutive salt candidates to collide with real, valid tool names.
    const names = [longName, other, initial, second, longName];
    const codec = chatToolNameCodec(names);
    const reversed = chatToolNameCodec([...names].reverse());
    expect(codec.toWire(initial)).toBe(initial);
    expect(codec.toWire(second)).toBe(second);
    expect(codec.toWire(longName)).not.toBe(initial);
    expect(codec.toWire(longName)).not.toBe(second);
    expect(new Set(names.map(name => codec.toWire(name))).size).toBe(4);
    for (const name of names) {
      expect(codec.fromWire(codec.toWire(name))).toBe(name);
      expect(codec.toWire(name)).toBe(reversed.toWire(name));
    }
  });
});

describe("Chat adapter reversible tool-name wire contract", () => {
  for (const namespace of [undefined, "mcp_namespace"]) {
    test(`declaration, forced choice, history and JSON response agree (${namespace ?? "bare"})`, async () => {
      const parsed = request(namespace);
      const before = JSON.stringify(parsed);
      const instance = adapter();
      const built = await instance.buildRequest(parsed);
      const wire = JSON.parse(built.body as string);
      const alias = wire.tools[0].function.name;
      const history = wire.messages.filter((message: { role: string }) => message.role === "assistant" || message.role === "tool");
      expect(alias).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(wire.tool_choice.function.name).toBe(alias);
      expect(history[0].tool_calls[0].function.name).toBe(alias);
      expect(history[0].tool_calls[0].function.arguments).toBe(JSON.stringify({ name: longName }));
      expect(history[0].tool_calls[0].id).toBe("call_original");
      expect(history[1].tool_call_id).toBe("call_original");
      expect(JSON.stringify(parsed)).toBe(before);
      const events = await instance.parseResponse!(Response.json({ choices: [{ message: { tool_calls: [
        { id: "response_call", function: { name: alias, arguments: "{}" } },
      ] } }] }));
      const start = events.find(event => event.type === "tool_call_start");
      const restored = namespace ? `${namespace}__${longName}` : longName;
      expect(start).toEqual({ type: "tool_call_start", id: "response_call", name: restored });
      if (namespace) expect(buildToolBridgeMaps(parsed).toolNsMap.get(restored)).toEqual({ namespace, name: longName });
    });
  }

  test("streamed parallel calls retain ID association and restore bare/namespaced names", async () => {
    const instance = adapter();
    const parsed = request("mcp");
    parsed.context.tools!.push({ name: "invalid.bare", description: "test", parameters: { type: "object" } });
    const built = await instance.buildRequest(parsed);
    const wire = JSON.parse(built.body as string);
    const calls = wire.tools.map((tool: { function: { name: string } }, index: number) => ({ index, id: `call_${index}`, function: { name: tool.function.name, arguments: "{" } }));
    const frames = [
      { choices: [{ delta: { tool_calls: calls } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"second":true}' } }, { index: 0, function: { arguments: '"first":true}' } }] }, finish_reason: "tool_calls" }] },
    ];
    const response = new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n");
    const events: AdapterEvent[] = [];
    for await (const event of instance.parseStream(response)) events.push(event);
    expect(events.filter(event => event.type === "tool_call_start")).toEqual([
      { type: "tool_call_start", id: "call_0", name: `mcp__${longName}` },
      { type: "tool_call_start", id: "call_1", name: "invalid.bare" },
    ]);
    expect(events.filter(event => event.type === "tool_call_delta")).toEqual([
      { type: "tool_call_delta", arguments: '{"first":true}' },
      { type: "tool_call_delta", arguments: '{"second":true}' },
    ]);
  });

  test("orphan namespaced results and history-only names use the same bounded alias", async () => {
    const parsed = request("mcp");
    parsed.context.messages.shift();
    const instance = adapter();
    const wire = JSON.parse((await instance.buildRequest(parsed)).body as string);
    const history = wire.messages.filter((message: { role: string }) => message.role === "assistant" || message.role === "tool");
    expect(history[0].tool_calls[0].function.name).toBe(wire.tools[0].function.name);
    expect(history[0].tool_calls[0].id).toBe(history[1].tool_call_id);
    parsed.context.tools = [];
    parsed.options = {};
    const historyOnly = JSON.parse((await instance.buildRequest(parsed)).body as string);
    expect(historyOnly.messages[0].tool_calls[0].function.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});
