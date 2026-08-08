import { Buffer } from "node:buffer";
import type { AdapterEvent, OcxUsage } from "../types";

export type PluginHookName =
  | "beforeAdapterRequest"
  | "afterAdapterEvent"
  | "onRequestComplete"
  | "onRequestError";

export type PluginSurface =
  | "responses"
  | "chat_completions"
  | "claude_messages"
  | "images"
  | "search"
  | "live"
  | "management"
  | "unknown";

export type PluginAdapterClass =
  | "openai-responses"
  | "openai-chat"
  | "anthropic"
  | "google"
  | "kiro"
  | "cursor"
  | "xai"
  | "custom"
  | "unknown";

export type PluginTerminalStatus = "completed" | "incomplete" | "failed";
export type PluginErrorClass = "abort" | "timeout" | "upstream" | "internal" | "unknown";
export type PluginHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "OTHER";

export interface PluginRequestContext {
  surface: PluginSurface;
  adapter: PluginAdapterClass;
  stream: boolean;
  attempt: number;
  startedAt: number;
}

export interface PluginUsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  estimated: boolean;
}

export interface BeforeAdapterRequestPayload {
  context: Readonly<PluginRequestContext>;
  request: Readonly<{
    method: PluginHttpMethod;
    bodyBytes: number;
    headerCount: number;
  }>;
}

export interface AdapterEventSummary {
  kind: AdapterEvent["type"];
  sequence: number;
  payloadBytes: number;
  terminalStatus?: PluginTerminalStatus;
  usage?: Readonly<PluginUsageSummary>;
  queryCount?: number;
  sourceCount?: number;
}

export interface AfterAdapterEventPayload {
  context: Readonly<PluginRequestContext>;
  event: Readonly<AdapterEventSummary>;
}

export interface RequestCompletePayload {
  context: Readonly<PluginRequestContext>;
  result: Readonly<{
    status: number;
    durationMs: number;
    terminalStatus: PluginTerminalStatus;
    usage?: Readonly<PluginUsageSummary>;
  }>;
}

export interface RequestErrorPayload {
  context: Readonly<PluginRequestContext>;
  error: Readonly<{
    status?: number;
    durationMs: number;
    errorClass: PluginErrorClass;
  }>;
}

export interface PluginHookPayloadMap {
  beforeAdapterRequest: BeforeAdapterRequestPayload;
  afterAdapterEvent: AfterAdapterEventPayload;
  onRequestComplete: RequestCompletePayload;
  onRequestError: RequestErrorPayload;
}

export interface OcxPlugin {
  id: string;
  beforeAdapterRequest?(payload: Readonly<BeforeAdapterRequestPayload>): void | Promise<void>;
  afterAdapterEvent?(payload: Readonly<AfterAdapterEventPayload>): void | Promise<void>;
  onRequestComplete?(payload: Readonly<RequestCompletePayload>): void | Promise<void>;
  onRequestError?(payload: Readonly<RequestErrorPayload>): void | Promise<void>;
}

export interface PluginHookFailure {
  pluginId: string;
  hook: PluginHookName;
  reason: "error" | "timeout";
}

export interface PluginRegistryOptions {
  hookTimeoutMs?: number;
  onFailure?: (failure: Readonly<PluginHookFailure>) => void;
}

const DEFAULT_HOOK_TIMEOUT_MS = 25;
const PLUGIN_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

class PluginHookTimeoutError extends Error {
  constructor() {
    super("plugin hook timed out");
    this.name = "PluginHookTimeoutError";
  }
}

function byteLength(value: string | undefined): number {
  return value ? Buffer.byteLength(value, "utf8") : 0;
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(value)));
}

function summarizeUsage(usage: OcxUsage | undefined): PluginUsageSummary | undefined {
  if (!usage) return undefined;
  const inputTokens = nonNegativeInteger(usage.inputTokens);
  const outputTokens = nonNegativeInteger(usage.outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage.totalTokens !== undefined
      ? nonNegativeInteger(usage.totalTokens)
      : nonNegativeInteger(inputTokens + outputTokens),
    ...(usage.cachedInputTokens !== undefined
      ? { cachedInputTokens: nonNegativeInteger(usage.cachedInputTokens) }
      : {}),
    ...(usage.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: nonNegativeInteger(usage.cacheReadInputTokens) }
      : {}),
    ...(usage.cacheCreationInputTokens !== undefined
      ? { cacheCreationInputTokens: nonNegativeInteger(usage.cacheCreationInputTokens) }
      : {}),
    ...(usage.reasoningOutputTokens !== undefined
      ? { reasoningOutputTokens: nonNegativeInteger(usage.reasoningOutputTokens) }
      : {}),
    estimated: usage.estimated === true,
  };
}

export function classifyPluginHttpMethod(method: string): PluginHttpMethod {
  const normalized = method.toUpperCase();
  switch (normalized) {
    case "GET":
    case "POST":
    case "PUT":
    case "PATCH":
    case "DELETE":
    case "OPTIONS":
      return normalized;
    default:
      return "OTHER";
  }
}

/**
 * Convert an adapter event into structural metadata only. Text, tool names and
 * arguments, ids, signatures, queries, source URLs, and error messages never
 * cross the plugin boundary.
 */
export function summarizeAdapterEvent(event: AdapterEvent, sequence: number): AdapterEventSummary {
  switch (event.type) {
    case "heartbeat":
    case "tool_call_end":
    case "assistant_boundary":
      return { kind: event.type, sequence, payloadBytes: 0 };
    case "text_delta":
      return { kind: event.type, sequence, payloadBytes: byteLength(event.text) };
    case "thinking_delta":
      return { kind: event.type, sequence, payloadBytes: byteLength(event.thinking) };
    case "thinking_signature":
      return { kind: event.type, sequence, payloadBytes: byteLength(event.signature) };
    case "redacted_thinking":
      return { kind: event.type, sequence, payloadBytes: byteLength(event.data) };
    case "reasoning_raw_delta":
      return { kind: event.type, sequence, payloadBytes: byteLength(event.text) };
    case "tool_call_start":
      return {
        kind: event.type,
        sequence,
        payloadBytes: byteLength(event.id) + byteLength(event.name),
      };
    case "tool_call_delta":
      return { kind: event.type, sequence, payloadBytes: byteLength(event.arguments) };
    case "web_search_call_begin":
      return { kind: event.type, sequence, payloadBytes: byteLength(event.id) };
    case "web_search_call_end":
      return {
        kind: event.type,
        sequence,
        payloadBytes: 0,
        queryCount: event.queries.length,
        sourceCount: event.sources?.length ?? 0,
      };
    case "done":
      return {
        kind: event.type,
        sequence,
        payloadBytes: 0,
        terminalStatus: "completed",
        ...(event.usage ? { usage: summarizeUsage(event.usage) } : {}),
      };
    case "incomplete":
      return {
        kind: event.type,
        sequence,
        payloadBytes: 0,
        terminalStatus: "incomplete",
        ...(event.usage ? { usage: summarizeUsage(event.usage) } : {}),
      };
    case "error":
      return {
        kind: event.type,
        sequence,
        payloadBytes: 0,
        terminalStatus: "failed",
        ...(event.usage ? { usage: summarizeUsage(event.usage) } : {}),
      };
    default: {
      // Bun runs TypeScript without a compile step, so a missed AdapterEvent
      // variant must fail here at compile time and still yield a safe,
      // structural summary at runtime instead of returning undefined.
      const exhaustive: never = event;
      return {
        kind: (exhaustive as AdapterEvent).type,
        sequence,
        payloadBytes: 0,
      };
    }
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

async function runWithTimeout(task: () => void | Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(task),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PluginHookTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function defaultFailureReporter(failure: Readonly<PluginHookFailure>): void {
  console.warn(
    `[plugins] ${failure.pluginId} ${failure.hook} ${failure.reason}; disabled for this request`,
  );
}

function bindPlugin(plugin: OcxPlugin): Readonly<OcxPlugin> {
  return Object.freeze({
    id: plugin.id,
    ...(typeof plugin.beforeAdapterRequest === "function"
      ? { beforeAdapterRequest: plugin.beforeAdapterRequest.bind(plugin) }
      : {}),
    ...(typeof plugin.afterAdapterEvent === "function"
      ? { afterAdapterEvent: plugin.afterAdapterEvent.bind(plugin) }
      : {}),
    ...(typeof plugin.onRequestComplete === "function"
      ? { onRequestComplete: plugin.onRequestComplete.bind(plugin) }
      : {}),
    ...(typeof plugin.onRequestError === "function"
      ? { onRequestError: plugin.onRequestError.bind(plugin) }
      : {}),
  });
}

export class PluginRegistry {
  private readonly plugins: Readonly<OcxPlugin>[] = [];
  private readonly ids = new Set<string>();
  private readonly hookTimeoutMs: number;
  private readonly onFailure: (failure: Readonly<PluginHookFailure>) => void;

  constructor(options: PluginRegistryOptions = {}) {
    const timeout = options.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60_000) {
      throw new RangeError("hookTimeoutMs must be an integer between 1 and 60000");
    }
    this.hookTimeoutMs = timeout;
    this.onFailure = options.onFailure ?? defaultFailureReporter;
  }

  register(plugin: OcxPlugin): void {
    if (!PLUGIN_ID.test(plugin.id)) throw new Error(`Invalid plugin id: ${plugin.id}`);
    if (this.ids.has(plugin.id)) throw new Error(`Duplicate plugin id: ${plugin.id}`);
    this.plugins.push(bindPlugin(plugin));
    this.ids.add(plugin.id);
  }

  registeredIds(): readonly string[] {
    return Object.freeze(this.plugins.map(plugin => plugin.id));
  }

  createSession(context: PluginRequestContext): PluginRequestSession {
    return new PluginRequestSession(
      this.plugins.slice(),
      deepFreeze({
        ...context,
        attempt: nonNegativeInteger(context.attempt),
        startedAt: nonNegativeInteger(context.startedAt),
      }),
      this.hookTimeoutMs,
      this.onFailure,
    );
  }
}

export class PluginRequestSession {
  private readonly failed = new Set<string>();
  private sequence = 0;

  constructor(
    private readonly plugins: readonly Readonly<OcxPlugin>[],
    private readonly context: Readonly<PluginRequestContext>,
    private readonly hookTimeoutMs: number,
    private readonly onFailure: (failure: Readonly<PluginHookFailure>) => void,
  ) {}

  private async dispatch<K extends PluginHookName>(
    hook: K,
    payload: Readonly<PluginHookPayloadMap[K]>,
  ): Promise<void> {
    for (const plugin of this.plugins) {
      if (this.failed.has(plugin.id)) continue;
      const handler = plugin[hook] as
        | ((value: Readonly<PluginHookPayloadMap[K]>) => void | Promise<void>)
        | undefined;
      if (!handler) continue;
      try {
        await runWithTimeout(() => handler(payload), this.hookTimeoutMs);
      } catch (error) {
        this.failed.add(plugin.id);
        const failure = deepFreeze<PluginHookFailure>({
          pluginId: plugin.id,
          hook,
          reason: error instanceof PluginHookTimeoutError ? "timeout" : "error",
        });
        try {
          this.onFailure(failure);
        } catch {
          // Diagnostics are best-effort and must never affect request processing.
        }
      }
    }
  }

  async beforeAdapterRequest(request: {
    method: string;
    bodyBytes: number;
    headerCount: number;
  }): Promise<void> {
    if (this.plugins.length === 0) return;
    const payload = deepFreeze<BeforeAdapterRequestPayload>({
      context: this.context,
      request: {
        method: classifyPluginHttpMethod(request.method),
        bodyBytes: nonNegativeInteger(request.bodyBytes),
        headerCount: nonNegativeInteger(request.headerCount),
      },
    });
    await this.dispatch("beforeAdapterRequest", payload);
  }

  async afterAdapterEvent(event: AdapterEvent): Promise<void> {
    if (this.plugins.length === 0) return;
    const payload = deepFreeze<AfterAdapterEventPayload>({
      context: this.context,
      event: summarizeAdapterEvent(event, this.sequence++),
    });
    await this.dispatch("afterAdapterEvent", payload);
  }

  async *observeAdapterEvents(source: AsyncIterable<AdapterEvent>): AsyncGenerator<AdapterEvent> {
    if (this.plugins.length === 0) {
      for await (const event of source) yield event;
      return;
    }
    for await (const event of source) {
      await this.afterAdapterEvent(event);
      yield event;
    }
  }

  async onRequestComplete(result: {
    status: number;
    durationMs: number;
    terminalStatus: PluginTerminalStatus;
    usage?: OcxUsage;
  }): Promise<void> {
    if (this.plugins.length === 0) return;
    const payload = deepFreeze<RequestCompletePayload>({
      context: this.context,
      result: {
        status: nonNegativeInteger(result.status),
        durationMs: nonNegativeInteger(result.durationMs),
        terminalStatus: result.terminalStatus,
        ...(result.usage ? { usage: summarizeUsage(result.usage) } : {}),
      },
    });
    await this.dispatch("onRequestComplete", payload);
  }

  async onRequestError(error: {
    status?: number;
    durationMs: number;
    errorClass: PluginErrorClass;
  }): Promise<void> {
    if (this.plugins.length === 0) return;
    const payload = deepFreeze<RequestErrorPayload>({
      context: this.context,
      error: {
        ...(error.status !== undefined ? { status: nonNegativeInteger(error.status) } : {}),
        durationMs: nonNegativeInteger(error.durationMs),
        errorClass: error.errorClass,
      },
    });
    await this.dispatch("onRequestError", payload);
  }
}

/** Compile-time registration surface. It is intentionally empty by default. */
export const pluginRegistry = new PluginRegistry();
