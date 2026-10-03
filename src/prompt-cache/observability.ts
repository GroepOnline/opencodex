import { createHash } from "node:crypto";

export type PromptCacheMode = "default" | "implicit" | "explicit";
export type PromptCacheLegacyRetention = "in_memory" | "24h";

export interface PromptCacheRequestObservation {
  version: 1;
  keyPresent: boolean;
  mode: PromptCacheMode;
  ttl?: "30m";
  legacyRetention?: PromptCacheLegacyRetention;
  prewarm: boolean;
  comparisonRequested: boolean;
  previousResponseIdPresent: boolean;
  breakpointCount: number;
  inputItemCount: number;
  toolCount: number;
  toolsFingerprint?: string;
  stablePrefixFingerprint?: string;
  textFormatFingerprint?: string;
  verbosity?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Serialize JSON-compatible input with stable object-key ordering.
 * Arrays retain their wire order and object keys such as "__proto__" remain ordinary data.
 */
function canonicalJson(value: unknown): string | undefined {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const items = value.map(item => canonicalJson(item) ?? "null");
    return "[" + items.join(",") + "]";
  }
  if (isRecord(value)) {
    const fields: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const child = canonicalJson(value[key]);
      if (child === undefined) continue;
      fields.push(JSON.stringify(key) + ":" + child);
    }
    return "{" + fields.join(",") + "}";
  }
  if (typeof value === "number" && !Number.isFinite(value)) return "null";
  if (
    typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  return undefined;
}

function fingerprint(value: unknown): string | undefined {
  const serialized = canonicalJson(value);
  if (serialized === undefined) return undefined;
  return createHash("sha256").update(serialized).digest("hex").slice(0, 24);
}

function countExplicitBreakpoints(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countExplicitBreakpoints(item), 0);
  }
  if (!isRecord(value)) return 0;
  const breakpoint = value.prompt_cache_breakpoint;
  let count = isRecord(breakpoint) && breakpoint.mode === "explicit" ? 1 : 0;
  for (const [key, child] of Object.entries(value)) {
    if (key === "prompt_cache_breakpoint") continue;
    count += countExplicitBreakpoints(child);
  }
  return count;
}

function stablePrefix(body: Record<string, unknown>): unknown[] {
  const prefix: unknown[] = [];
  if (body.instructions !== undefined) {
    prefix.push({ kind: "instructions", value: body.instructions });
  }
  if (!Array.isArray(body.input)) return prefix;

  const initialDeveloperItems: unknown[] = [];
  for (const item of body.input) {
    if (!isRecord(item)) break;
    if (item.role !== "developer" && item.role !== "system") break;
    initialDeveloperItems.push(item);
  }
  if (initialDeveloperItems.length > 0) {
    prefix.push({ kind: "initial_developer_messages", value: initialDeveloperItems });
  }
  return prefix;
}

function boundedString(value: unknown, maxLength = 32): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

export function observeOpenAiResponsesPromptCache(
  value: unknown,
): PromptCacheRequestObservation | undefined {
  if (!isRecord(value)) return undefined;

  const options = isRecord(value.prompt_cache_options)
    ? value.prompt_cache_options
    : undefined;
  const mode: PromptCacheMode = options?.mode === "explicit"
    ? "explicit"
    : options?.mode === "implicit"
      ? "implicit"
      : "default";
  const ttl: PromptCacheRequestObservation["ttl"] =
    options?.ttl === "30m" ? "30m" : undefined;
  const retention = value.prompt_cache_retention === "in_memory"
    || value.prompt_cache_retention === "24h"
    ? value.prompt_cache_retention
    : undefined;
  const tools = Array.isArray(value.tools) ? value.tools : [];
  const input = value.input;
  const prefix = stablePrefix(value);
  const text = isRecord(value.text) ? value.text : undefined;
  const textFormat = text?.format;
  const verbosity = boundedString(text?.verbosity);

  return {
    version: 1,
    keyPresent: typeof value.prompt_cache_key === "string"
      && value.prompt_cache_key.trim().length > 0,
    mode,
    ...(ttl ? { ttl } : {}),
    ...(retention ? { legacyRetention: retention } : {}),
    prewarm: options?.prewarm === true,
    comparisonRequested: typeof options?.comparison_response_id === "string"
      && options.comparison_response_id.trim().length > 0,
    previousResponseIdPresent: typeof value.previous_response_id === "string"
      && value.previous_response_id.trim().length > 0,
    breakpointCount: countExplicitBreakpoints(input),
    inputItemCount: Array.isArray(input) ? input.length : input === undefined ? 0 : 1,
    toolCount: tools.length,
    ...(tools.length > 0 ? { toolsFingerprint: fingerprint(tools) } : {}),
    ...(prefix.length > 0 ? { stablePrefixFingerprint: fingerprint(prefix) } : {}),
    ...(textFormat !== undefined ? { textFormatFingerprint: fingerprint(textFormat) } : {}),
    ...(verbosity ? { verbosity } : {}),
  };
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{24}$/u.test(value);
}

function isBoundedCount(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= 1_000_000;
}

export function normalizePromptCacheRequestObservation(
  value: unknown,
): PromptCacheRequestObservation | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (typeof value.keyPresent !== "boolean"
    || typeof value.prewarm !== "boolean"
    || typeof value.comparisonRequested !== "boolean"
    || typeof value.previousResponseIdPresent !== "boolean"
    || !isBoundedCount(value.breakpointCount)
    || !isBoundedCount(value.inputItemCount)
    || !isBoundedCount(value.toolCount)) {
    return undefined;
  }
  const mode = value.mode === "default"
    || value.mode === "implicit"
    || value.mode === "explicit"
    ? value.mode
    : undefined;
  if (!mode) return undefined;

  const ttl = value.ttl === "30m" ? value.ttl : undefined;
  const legacyRetention = value.legacyRetention === "in_memory"
    || value.legacyRetention === "24h"
    ? value.legacyRetention
    : undefined;
  const verbosity = boundedString(value.verbosity);
  return {
    version: 1,
    keyPresent: value.keyPresent,
    mode,
    ...(ttl ? { ttl } : {}),
    ...(legacyRetention ? { legacyRetention } : {}),
    prewarm: value.prewarm,
    comparisonRequested: value.comparisonRequested,
    previousResponseIdPresent: value.previousResponseIdPresent,
    breakpointCount: value.breakpointCount,
    inputItemCount: value.inputItemCount,
    toolCount: value.toolCount,
    ...(isFingerprint(value.toolsFingerprint)
      ? { toolsFingerprint: value.toolsFingerprint } : {}),
    ...(isFingerprint(value.stablePrefixFingerprint)
      ? { stablePrefixFingerprint: value.stablePrefixFingerprint } : {}),
    ...(isFingerprint(value.textFormatFingerprint)
      ? { textFormatFingerprint: value.textFormatFingerprint } : {}),
    ...(verbosity ? { verbosity } : {}),
  };
}
