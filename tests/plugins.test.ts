import { describe, expect, test } from "bun:test";
import {
  PluginRegistry,
  summarizeAdapterEvent,
  type AfterAdapterEventPayload,
  type BeforeAdapterRequestPayload,
  type OcxPlugin,
  type PluginHookFailure,
  type PluginRequestContext,
} from "../src/plugins";
import type { AdapterEvent } from "../src/types";

const context: PluginRequestContext = {
  surface: "responses",
  adapter: "openai-chat",
  stream: true,
  attempt: 1,
  startedAt: 100,
};

async function collect(source: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const result: AdapterEvent[] = [];
  for await (const event of source) result.push(event);
  return result;
}

async function* events(values: readonly AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const event of values) yield event;
}

function numericValues(value: unknown): number[] {
  if (typeof value === "number") return [value];
  if (Array.isArray(value)) return value.flatMap(numericValues);
  if (value && typeof value === "object") return Object.values(value).flatMap(numericValues);
  return [];
}

describe("plugin registry", () => {
  test("runs hooks in deterministic registration order", async () => {
    const calls: string[] = [];
    const registry = new PluginRegistry();
    registry.register({
      id: "first",
      beforeAdapterRequest: () => { calls.push("first:before"); },
      afterAdapterEvent: () => { calls.push("first:event"); },
    });
    registry.register({
      id: "second",
      beforeAdapterRequest: () => { calls.push("second:before"); },
      afterAdapterEvent: () => { calls.push("second:event"); },
    });

    const session = registry.createSession(context);
    await session.beforeAdapterRequest({ method: "POST", bodyBytes: 12, headerCount: 3 });
    await session.afterAdapterEvent({ type: "heartbeat" });

    expect(calls).toEqual([
      "first:before",
      "second:before",
      "first:event",
      "second:event",
    ]);
    expect(registry.registeredIds()).toEqual(["first", "second"]);
  });

  test("preserves prototype hooks and their instance context", async () => {
    const calls: string[] = [];

    class StatefulPlugin implements OcxPlugin {
      readonly id = "stateful-plugin";

      constructor(private readonly prefix: string) {}

      beforeAdapterRequest(payload: Readonly<BeforeAdapterRequestPayload>): void {
        calls.push(`${this.prefix}:${payload.request.method}`);
      }
    }

    const registry = new PluginRegistry();
    registry.register(new StatefulPlugin("instance-state"));

    await registry.createSession(context).beforeAdapterRequest({
      method: "post",
      bodyBytes: 0,
      headerCount: 0,
    });

    expect(calls).toEqual(["instance-state:POST"]);
  });

  test("snapshots registration when a request session is created", async () => {
    const calls: string[] = [];
    const registry = new PluginRegistry();
    registry.register({ id: "first", afterAdapterEvent: () => { calls.push("first"); } });
    const session = registry.createSession(context);
    registry.register({ id: "later", afterAdapterEvent: () => { calls.push("later"); } });

    await session.afterAdapterEvent({ type: "heartbeat" });

    expect(calls).toEqual(["first"]);
  });

  test("enforces plugin id syntax and length boundaries", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "valid-plugin" });

    expect(() => registry.register({ id: "valid-plugin" })).toThrow("Duplicate plugin id");
    expect(() => registry.register({ id: "Invalid Plugin" })).toThrow("Invalid plugin id");

    for (const id of [
      "",
      ".leading",
      "-leading",
      "_leading",
      "trailing.",
      "trailing-",
      "trailing_",
      "a".repeat(65),
    ]) {
      expect(() => registry.register({ id })).toThrow("Invalid plugin id");
    }
    for (const id of ["a", "a.b_c-d", "a".repeat(64)]) {
      expect(() => registry.register({ id })).not.toThrow();
    }
  });

  test("disables only the failing plugin for the rest of the request", async () => {
    const calls: string[] = [];
    const failures: PluginHookFailure[] = [];
    const registry = new PluginRegistry({ onFailure: failure => failures.push({ ...failure }) });
    registry.register({
      id: "broken",
      beforeAdapterRequest: () => { throw new Error("secret-bearing error must not be reported"); },
      afterAdapterEvent: () => { calls.push("broken:event"); },
      onRequestComplete: () => { calls.push("broken:complete"); },
    });
    registry.register({
      id: "healthy",
      beforeAdapterRequest: () => { calls.push("healthy:before"); },
      afterAdapterEvent: () => { calls.push("healthy:event"); },
      onRequestComplete: () => { calls.push("healthy:complete"); },
    });

    const session = registry.createSession(context);
    await session.beforeAdapterRequest({ method: "POST", bodyBytes: 0, headerCount: 0 });
    await session.afterAdapterEvent({ type: "heartbeat" });
    await session.onRequestComplete({ status: 200, durationMs: 10, terminalStatus: "completed" });

    expect(calls).toEqual(["healthy:before", "healthy:event", "healthy:complete"]);
    expect(failures).toEqual([{
      pluginId: "broken",
      hook: "beforeAdapterRequest",
      reason: "error",
    }]);
    expect(JSON.stringify(failures)).not.toContain("secret-bearing");

    calls.length = 0;
    const nextSession = registry.createSession(context);
    await nextSession.afterAdapterEvent({ type: "heartbeat" });
    expect(calls).toEqual(["broken:event", "healthy:event"]);
  });

  test("bounds a hanging hook and continues with later plugins", async () => {
    const calls: string[] = [];
    const failures: PluginHookFailure[] = [];
    const registry = new PluginRegistry({
      hookTimeoutMs: 5,
      onFailure: failure => failures.push({ ...failure }),
    });
    registry.register({
      id: "hanging",
      beforeAdapterRequest: () => new Promise<void>(() => undefined),
    });
    registry.register({
      id: "healthy",
      beforeAdapterRequest: () => { calls.push("healthy"); },
    });

    const started = Date.now();
    await registry.createSession(context).beforeAdapterRequest({
      method: "POST",
      bodyBytes: 1,
      headerCount: 1,
    });

    expect(Date.now() - started).toBeLessThan(250);
    expect(calls).toEqual(["healthy"]);
    expect(failures).toEqual([{
      pluginId: "hanging",
      hook: "beforeAdapterRequest",
      reason: "timeout",
    }]);
  });
});

describe("plugin privacy boundary", () => {
  test("summarizes text, tool, search, and error events without content", () => {
    const sensitiveEvents: AdapterEvent[] = [
      { type: "text_delta", text: "prompt-secret" },
      { type: "tool_call_start", id: "call-secret", name: "dangerous-secret-tool" },
      { type: "tool_call_delta", arguments: "{\"token\":\"secret\"}" },
      {
        type: "web_search_call_end",
        id: "search-secret",
        queries: ["private query"],
        sources: [{ url: "https://secret.invalid", title: "private title" }],
      },
      { type: "error", message: "Bearer secret-token", code: "upstream_secret" },
    ];

    const summaries = sensitiveEvents.map((event, sequence) => summarizeAdapterEvent(event, sequence));
    const serialized = JSON.stringify(summaries);

    expect(summaries.map(summary => summary.kind)).toEqual([
      "text_delta",
      "tool_call_start",
      "tool_call_delta",
      "web_search_call_end",
      "error",
    ]);
    expect(summaries[3]).toMatchObject({ queryCount: 1, sourceCount: 1 });
    expect(summaries[4]).toMatchObject({ terminalStatus: "failed", payloadBytes: 0 });
    for (const secret of [
      "prompt-secret",
      "call-secret",
      "dangerous-secret-tool",
      "secret-token",
      "private query",
      "secret.invalid",
      "private title",
      "upstream_secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test("freezes payloads and preserves event identity and stream ordering", async () => {
    const observed: Readonly<AfterAdapterEventPayload>[] = [];
    const frozen: boolean[] = [];
    const registry = new PluginRegistry();
    registry.register({
      id: "observer",
      afterAdapterEvent: payload => {
        observed.push(payload);
        frozen.push(
          Object.isFrozen(payload)
          && Object.isFrozen(payload.context)
          && Object.isFrozen(payload.event),
        );
      },
    });
    const session = registry.createSession(context);
    const values: AdapterEvent[] = [
      { type: "heartbeat" },
      { type: "text_delta", text: "unchanged" },
      { type: "done", usage: { inputTokens: 2, outputTokens: 3 } },
    ];

    const output = await collect(session.observeAdapterEvents(events(values)));

    expect(frozen).toEqual([true, true, true]);
    expect(output).toEqual(values);
    expect(output[1]).toBe(values[1]);
    expect(observed.map(payload => payload.event.sequence)).toEqual([0, 1, 2]);
    expect(observed[1].event).toEqual({
      kind: "text_delta",
      sequence: 1,
      payloadBytes: 9,
    });
    expect(observed[2].event).toMatchObject({
      kind: "done",
      sequence: 2,
      terminalStatus: "completed",
      usage: {
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
        estimated: false,
      },
    });
  });

  test("normalizes every numeric field crossing the plugin boundary", async () => {
    const seen: unknown[] = [];
    const registry = new PluginRegistry();
    registry.register({
      id: "numeric-observer",
      afterAdapterEvent: payload => { seen.push(payload); },
      onRequestComplete: payload => { seen.push(payload); },
      onRequestError: payload => { seen.push(payload); },
    });
    const session = registry.createSession({
      ...context,
      attempt: Number.NaN,
      startedAt: Number.POSITIVE_INFINITY,
    });

    await session.afterAdapterEvent({
      type: "done",
      usage: {
        inputTokens: Number.NaN,
        outputTokens: Number.POSITIVE_INFINITY,
        totalTokens: -1.8,
        cachedInputTokens: 1.9,
        cacheReadInputTokens: 2.9,
        cacheCreationInputTokens: -3,
        reasoningOutputTokens: Number.NEGATIVE_INFINITY,
      },
    });
    await session.onRequestComplete({
      status: Number.NaN,
      durationMs: 4.9,
      terminalStatus: "completed",
      usage: { inputTokens: 2.8, outputTokens: 3.9 },
    });
    await session.onRequestError({
      status: Number.POSITIVE_INFINITY,
      durationMs: -2.5,
      errorClass: "upstream",
    });

    expect(seen).toHaveLength(3);
    const numbers = seen.flatMap(numericValues);
    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers.every(value => Number.isSafeInteger(value) && value >= 0)).toBe(true);
    expect(seen[0]).toMatchObject({
      context: { attempt: 0, startedAt: 0 },
      event: {
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cachedInputTokens: 1,
          cacheReadInputTokens: 2,
          cacheCreationInputTokens: 0,
          reasoningOutputTokens: 0,
        },
      },
    });
    expect(seen[1]).toMatchObject({
      result: {
        status: 0,
        durationMs: 4,
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      },
    });
    expect(seen[2]).toMatchObject({ error: { status: 0, durationMs: 0 } });
  });

  test("completion and error hooks expose classified metadata only", async () => {
    const seen: unknown[] = [];
    const registry = new PluginRegistry();
    registry.register({
      id: "terminal-observer",
      onRequestComplete: payload => { seen.push(payload); },
      onRequestError: payload => { seen.push(payload); },
    });
    const session = registry.createSession(context);

    await session.onRequestComplete({
      status: 200,
      durationMs: 15,
      terminalStatus: "completed",
      usage: { inputTokens: 4, outputTokens: 6, cachedInputTokens: 1 },
    });
    await session.onRequestError({ status: 502, durationMs: 20, errorClass: "upstream" });

    expect(seen).toHaveLength(2);
    expect(JSON.stringify(seen)).not.toContain("message");
    expect(seen[0]).toMatchObject({
      result: {
        status: 200,
        durationMs: 15,
        terminalStatus: "completed",
        usage: { totalTokens: 10, cachedInputTokens: 1 },
      },
    });
    expect(seen[1]).toMatchObject({
      error: { status: 502, durationMs: 20, errorClass: "upstream" },
    });
  });
});
