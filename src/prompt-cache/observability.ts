import { createHash } from "node:crypto";

export type PromptCacheMode = "default" | "implicit" | "explicit";
export type PromptCacheLegacyRetention = "in_memory" | "24h";
export type PromptCacheVerbosity = "low" | "medium" | "high";

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
  verbosity?: PromptCacheVerbosity;
}

/** Narrow a value to a non-null, non-array object before reading request fields. */
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
    const items = value.map((item) => canonicalJson(item) ?? "null");
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
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  return undefined;
}

/** Hash canonical JSON to 24 lowercase hex characters, or return undefined for unsupported values. */
function fingerprint(value: unknown): string | undefined {
  const serialized = canonicalJson(value);
  if (serialized === undefined) return undefined;
  return createHash("sha256").update(serialized).digest("hex").slice(0, 24);
}

/** Recursively count explicit prompt-cache breakpoints without descending into breakpoint metadata. */
function countExplicitBreakpoints(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce(
      (total, item) => total + countExplicitBreakpoints(item),
      0,
    );
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

/** Collect instructions and consecutive leading developer/system messages for fingerprinting. */
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
    prefix.push({
      kind: "initial_developer_messages",
      value: initialDeveloperItems,
    });
  }
  return prefix;
}

/** Accept only supported verbosity labels so arbitrary caller text is omitted from diagnostics. */
function promptCacheVerbosity(
  value: unknown,
): PromptCacheVerbosity | undefined {
  if (value === "low" || value === "medium" || value === "high") return value;
  return undefined;
}

/** Check for non-whitespace string content without retaining the string value. */
function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** Read a recognized outbound cache mode, falling back to default for absent or unknown values. */
function promptCacheMode(
  options: Record<string, unknown> | undefined,
): PromptCacheMode {
  if (options?.mode === "explicit") return "explicit";
  if (options?.mode === "implicit") return "implicit";
  return "default";
}

/** Extract the supported 30-minute TTL from outbound cache options. */
function promptCacheTtl(
  options: Record<string, unknown> | undefined,
): PromptCacheRequestObservation["ttl"] {
  return options?.ttl === "30m" ? "30m" : undefined;
}

/** Accept only the supported legacy retention labels, omitting unknown values. */
function promptCacheLegacyRetention(
  value: unknown,
): PromptCacheLegacyRetention | undefined {
  if (value === "in_memory" || value === "24h") return value;
  return undefined;
}

/** Count input-array items, treating absent input as zero and other input values as one. */
function promptCacheInputItemCount(input: unknown): number {
  if (Array.isArray(input)) return input.length;
  return input === undefined ? 0 : 1;
}

interface PromptCacheObservationExtras {
  toolsFingerprint?: string;
  stablePrefixFingerprint?: string;
  textFormatFingerprint?: string;
  verbosity?: PromptCacheVerbosity;
}

/** Fingerprint present tools, stable prefix, and text format, and include supported verbosity. */
function promptCacheObservationExtras(input: {
  tools: unknown[];
  prefix: unknown[];
  textFormat: unknown;
  verbosity: PromptCacheVerbosity | undefined;
}): PromptCacheObservationExtras {
  const extras: PromptCacheObservationExtras = {};
  if (input.tools.length > 0)
    extras.toolsFingerprint = fingerprint(input.tools);
  if (input.prefix.length > 0)
    extras.stablePrefixFingerprint = fingerprint(input.prefix);
  if (input.textFormat !== undefined) {
    extras.textFormatFingerprint = fingerprint(input.textFormat);
  }
  if (input.verbosity) extras.verbosity = input.verbosity;
  return extras;
}

/**
 * Describe cache settings and request structure from the final outbound Responses body.
 * Retain fingerprints and presence flags rather than raw content or cache keys.
 * Return undefined for non-object input without changing the supplied body.
 */
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
  const verbosity = promptCacheVerbosity(text?.verbosity);

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

/** Check that a persisted fingerprint contains exactly 24 lowercase hexadecimal characters. */
function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{24}$/u.test(value);
}

/** Accept persisted integer counts from zero through one million. */
function isBoundedCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 1_000_000
  );
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

/** Validate the required boolean flags and bounded counts of a persisted observation. */
function hasPromptCacheObservationCore(
  value: Record<string, unknown>,
): value is Record<string, unknown> & PromptCacheObservationCore {
  return (
    typeof value.keyPresent === "boolean" &&
    typeof value.prewarm === "boolean" &&
    typeof value.comparisonRequested === "boolean" &&
    typeof value.previousResponseIdPresent === "boolean" &&
    isBoundedCount(value.breakpointCount) &&
    isBoundedCount(value.inputItemCount) &&
    isBoundedCount(value.toolCount)
  );
}

/** Accept a persisted cache-mode label, returning undefined for unrecognized values. */
function normalizedPromptCacheMode(
  value: unknown,
): PromptCacheMode | undefined {
  if (value === "default" || value === "implicit" || value === "explicit")
    return value;
  return undefined;
}

/** Retain only the supported 30-minute TTL from a persisted observation. */
function normalizedPromptCacheTtl(
  value: unknown,
): PromptCacheRequestObservation["ttl"] {
  return value === "30m" ? "30m" : undefined;
}

/** Copy only well-formed fingerprints and supported verbosity from persisted metadata. */
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
  const verbosity = promptCacheVerbosity(value.verbosity);
  if (verbosity) extras.verbosity = verbosity;
  return extras;
}

/**
 * Validate untrusted persisted metadata and rebuild an allowlisted version-1 observation.
 * Reject invalid versions or required fields; omit unknown fields and invalid optional values.
 */
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
