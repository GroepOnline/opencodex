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

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function promptCacheMode(options: Record<string, unknown> | undefined): PromptCacheMode {
  if (options?.mode === "explicit") return "explicit";
  if (options?.mode === "implicit") return "implicit";
  return "default";
}

function promptCacheTtl(
  options: Record<string, unknown> | undefined,
): PromptCacheRequestObservation["ttl"] {
  return options?.ttl === "30m" ? "30m" : undefined;
}

function promptCacheLegacyRetention(value: unknown): PromptCacheLegacyRetention | undefined {
  if (value === "in_memory" || value === "24h") return value;
  return undefined;
}

function promptCacheInputItemCount(input: unknown): number {
  if (Array.isArray(input)) return input.length;
  return input === undefined ? 0 : 1;
}

interface PromptCacheObservationExtras {
  toolsFingerprint?: string;
  stablePrefixFingerprint?: string;
  textFormatFingerprint?: string;
  verbosity?: string;
}

function promptCacheObservationExtras(input: {
  tools: unknown[];
  prefix: unknown[];
  textFormat: unknown;
  verbosity: string | undefined;
}): PromptCacheObservationExtras {
  const extras: PromptCacheObservationExtras = {};
  if (input.tools.length > 0) extras.toolsFingerprint = fingerprint(input.tools);
  if (input.prefix.length > 0) extras.stablePrefixFingerprint = fingerprint(input.prefix);
  if (input.textFormat !== undefined) {
    extras.textFormatFingerprint = fingerprint(input.textFormat);
  }
  if (input.verbosity) extras.verbosity = input.verbosity;
  return extras;
}

export function observeOpenAiResponsesPromptCache(
  value: unknown,
): PromptCacheRequestObservation | undefined {
  if (!isRecord(value)) return undefined;

  const options = isRecord(value.prompt_cache_options)
    ? value.prompt_cache_options
    : undefined;
  const ttl = promptCacheTtl(options);
  const retention = promptCacheLegacyRetention(value.prompt_cache_retention);
  const tools = Array.isArray(value.tools) ? value.tools : [];
  const input = value.input;
  const prefix = stablePrefix(value);
  const text = isRecord(value.text) ? value.text : undefined;
  const textFormat = text?.format;
  const verbosity = boundedString(text?.verbosity);

  return {
    version: 1,
    keyPresent: hasNonEmptyString(value.prompt_cache_key),
    mode: promptCacheMode(options),
    ...(ttl ? { ttl } : {}),
    ...(retention ? { legacyRetention: retention } : {}),
    prewarm: options?.prewarm === true,
    comparisonRequested: hasNonEmptyString(options?.comparison_response_id),
    previousResponseIdPresent: hasNonEmptyString(value.previous_response_id),
    breakpointCount: countExplicitBreakpoints(input),
    inputItemCount: promptCacheInputItemCount(input),
    toolCount: tools.length,
    ...promptCacheObservationExtras({ tools, prefix, textFormat, verbosity }),
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

interface PromptCacheObservationCore {
  keyPresent: boolean;
  prewarm: boolean;
  comparisonRequested: boolean;
  previousResponseIdPresent: boolean;
  breakpointCount: number;
  inputItemCount: number;
  toolCount: number;
}

function hasPromptCacheObservationCore(
  value: Record<string, unknown>,
): value is Record<string, unknown> & PromptCacheObservationCore {
  return typeof value.keyPresent === "boolean"
    && typeof value.prewarm === "boolean"
    && typeof value.comparisonRequested === "boolean"
    && typeof value.previousResponseIdPresent === "boolean"
    && isBoundedCount(value.breakpointCount)
    && isBoundedCount(value.inputItemCount)
    && isBoundedCount(value.toolCount);
}

function normalizedPromptCacheMode(value: unknown): PromptCacheMode | undefined {
  if (value === "default" || value === "implicit" || value === "explicit") return value;
  return undefined;
}

function normalizedPromptCacheTtl(value: unknown): PromptCacheRequestObservation["ttl"] {
  return value === "30m" ? "30m" : undefined;
}

function normalizedPromptCacheExtras(
  value: Record<string, unknown>,
): PromptCacheObservationExtras {
  const extras: PromptCacheObservationExtras = {};
  if (isFingerprint(value.toolsFingerprint)) {
    extras.toolsFingerprint = value.toolsFingerprint;
  }
  if (isFingerprint(value.stablePrefixFingerprint)) {
    extras.stablePrefixFingerprint = value.stablePrefixFingerprint;
  }
  if (isFingerprint(value.textFormatFingerprint)) {
    extras.textFormatFingerprint = value.textFormatFingerprint;
  }
  const verbosity = boundedString(value.verbosity);
  if (verbosity) extras.verbosity = verbosity;
  return extras;
}

export function normalizePromptCacheRequestObservation(
  value: unknown,
): PromptCacheRequestObservation | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (!hasPromptCacheObservationCore(value)) return undefined;
  const mode = normalizedPromptCacheMode(value.mode);
  if (!mode) return undefined;

  const ttl = normalizedPromptCacheTtl(value.ttl);
  const legacyRetention = promptCacheLegacyRetention(value.legacyRetention);
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
    ...normalizedPromptCacheExtras(value),
  };
}
