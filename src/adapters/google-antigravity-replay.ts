/**
 * Antigravity (Cloud Code Assist) thoughtSignature reasoning-replay cache.
 *
 * Gemini-3 interleaved thinking is stateless upstream: each model content part carries a
 * `thoughtSignature` that MUST be echoed back on the matching part in the next request, or the
 * upstream rejects the turn (HTTP 400). We observe signatures on the response stream, cache them
 * per `model + session`, and re-inject them into the outgoing `request.contents` on the next turn.
 *
 * Mirrors CLIProxyAPI `internal/runtime/executor/antigravity_reasoning_replay.go`. Gemini-only;
 * Claude-on-Antigravity uses inline signature sanitization instead (see google-antigravity-wire).
 */

interface ReplayEntry {
  /** thoughtSignature keyed by functionCall identity (name + canonical args). */
  byCall: Map<string, string>;
  expiresAtMs: number;
}

/**
 * Official Google dummy signature that skips upstream validation
 * (https://ai.google.dev/gemini-api/docs/thought-signatures). Vertex-style validators accept only
 * this spelling, so it is the safe choice for Cloud Code Assist. Filled onto model functionCall
 * parts whose real signature is unknown (proxy restart, TTL expiry, clear-on-invalid, or history
 * imported from another model/session): Gemini-3 otherwise hard-fails the whole turn with
 * HTTP 400 "Function call is missing a thought_signature". Degraded reasoning beats a dead session.
 */
export const DUMMY_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

const MIN_SIGNATURE_LEN = 16;
const REPLAY_TTL_MS = 60 * 60 * 1000; // 1h
const REPLAY_MAX_ENTRIES = 10_240;
const REPLAY_EVICT_BATCH = 128;

const replayCache = new Map<string, ReplayEntry>();

function replayKey(model: string, sessionId: string): string {
  return `${model}::session:${sessionId}`;
}

/** Recursively canonicalize a JSON value: object keys sorted, arrays preserved. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>).sort()
    .map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(",")}}`;
}

/** Stable identity for a functionCall part: name + recursively canonicalized args. */
function functionCallKey(name: unknown, args: unknown): string | undefined {
  if (typeof name !== "string" || name.length === 0) return undefined;
  let argsKey = "";
  try {
    argsKey = canonicalJson(args ?? {});
  } catch {
    argsKey = "";
  }
  return `${name}::${argsKey}`;
}

function extractSignature(part: Record<string, unknown>): string | undefined {
  const direct = part.thoughtSignature ?? part.thought_signature;
  if (typeof direct === "string" && direct.length >= MIN_SIGNATURE_LEN) return direct;
  const extra = part.extra_content as { google?: { thought_signature?: unknown } } | undefined;
  const nested = extra?.google?.thought_signature;
  if (typeof nested === "string" && nested.length >= MIN_SIGNATURE_LEN) return nested;
  return undefined;
}

function evictIfNeeded(): void {
  if (replayCache.size <= REPLAY_MAX_ENTRIES) return;
  const oldest = [...replayCache.entries()]
    .sort((a, b) => a[1].expiresAtMs - b[1].expiresAtMs)
    .slice(0, REPLAY_EVICT_BATCH);
  for (const [key] of oldest) replayCache.delete(key);
}

/** Gemini/Flash/Agent use the replay cache; Claude does not (inline sanitization instead). */
export function antigravityUsesReplayCache(model: string): boolean {
  return !/claude/i.test(model);
}

/**
 * Observe a parsed CCA chunk's `candidates[0].content.parts` and record thought signatures keyed by
 * the functionCall identity (name + args). Accumulates across the whole session so a sequential
 * multi-step tool loop keeps EVERY prior call's signature, not just the latest part-index slot.
 * `parts` is the already-unwrapped `response.candidates[0].content.parts`.
 */
export function observeAntigravityReplay(model: string, sessionId: string, parts: unknown[]): void {
  if (!antigravityUsesReplayCache(model) || !Array.isArray(parts) || parts.length === 0) return;
  const key = replayKey(model, sessionId);
  const entry = replayCache.get(key) ?? { byCall: new Map<string, string>(), expiresAtMs: 0 };
  let changed = false;
  for (const raw of parts) {
    if (!raw || typeof raw !== "object") continue;
    const part = raw as Record<string, unknown>;
    const sig = extractSignature(part);
    if (!sig) continue;
    const fc = part.functionCall as { name?: unknown; args?: unknown } | undefined;
    const ck = fc ? functionCallKey(fc.name, fc.args) : undefined;
    if (!ck) continue; // only function-call signatures are replayable by identity
    if (entry.byCall.get(ck) !== sig) { entry.byCall.set(ck, sig); changed = true; }
  }
  if (!changed && replayCache.has(key)) return;
  entry.expiresAtMs = Date.now() + REPLAY_TTL_MS;
  replayCache.set(key, entry);
  evictIfNeeded();
}

/**
 * Re-inject cached thought signatures into the outgoing `request.contents`, matched by functionCall
 * identity across ALL model turns (not just the last one). A functionCall part whose real signature
 * is unknown (cache miss) is filled with `DUMMY_THOUGHT_SIGNATURE` instead of being left bare,
 * because Gemini-3 rejects the entire turn (HTTP 400) on any uncovered functionCall part.
 * Returns the same array reference (mutated in place).
 */
export function applyAntigravityReplay(model: string, sessionId: string, contents: unknown[]): unknown[] {
  if (!antigravityUsesReplayCache(model) || !Array.isArray(contents)) return contents;
  const key = replayKey(model, sessionId);
  let entry = replayCache.get(key);
  if (entry && entry.expiresAtMs <= Date.now()) {
    replayCache.delete(key);
    entry = undefined;
  }
  for (const c of contents as { role?: string; parts?: unknown[] }[]) {
    if (!c || typeof c !== "object" || c.role !== "model" || !Array.isArray(c.parts)) continue;
    for (const raw of c.parts) {
      if (!raw || typeof raw !== "object") continue;
      const part = raw as Record<string, unknown>;
      const fc = part.functionCall as { name?: unknown; args?: unknown } | undefined;
      if (!fc) continue;
      const ck = functionCallKey(fc.name, fc.args);
      const cached = ck ? entry?.byCall.get(ck) : undefined;
      const existing = part.thoughtSignature ?? part.thought_signature;
      if (existing !== undefined) {
        // Upgrade a dummy left by a previous fallback roundtrip when the real signature is known.
        if (cached && existing === DUMMY_THOUGHT_SIGNATURE) {
          part.thoughtSignature = cached;
          delete part.thought_signature;
        }
        continue;
      }
      part.thoughtSignature = cached ?? DUMMY_THOUGHT_SIGNATURE;
    }
  }
  return contents;
}

/** Drop the cache entry when upstream rejects a signature (clear-on-invalid). */
export function clearAntigravityReplay(model: string, sessionId: string): void {
  replayCache.delete(replayKey(model, sessionId));
}

/** Test seam. */
export function __resetAntigravityReplayCache(): void {
  replayCache.clear();
}
