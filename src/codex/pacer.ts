import type { OcxConfig } from "../types";
import { isSelectableCodexPoolAccount } from "./account-id";

/**
 * Jittered inter-request pacer for outbound Codex pool calls.
 *
 * Off by default (`config.codexRequestPacing?.enabled` falsy). When enabled, each
 * pool account keeps its own `lastSendAt` timestamp and a new send waits a
 * randomized gap in `[minMs, maxMs]` minus the time elapsed since that account's
 * previous send (floored at 0). Per-account state means a multi-account pool
 * desyncs instead of aligning into a single fixed, ban-prone cadence.
 *
 * Defaults preserve current behavior: disabled resolves instantly and never
 * awaits, so single-account and pre-pacing setups are untouched.
 *
 * Ported from GroepOnline `main` (PR #4 / baadc835) and re-wired into the
 * current `responses/core.ts` send path — the original `responses.ts` call site
 * was lost during the responses split on `main`.
 */

const PACE_DEFAULT_MIN_MS = 150;
const PACE_DEFAULT_MAX_MS = 900;

/**
 * Per-account reserved send timestamps (ms). Module-level, in-process,
 * non-persistent. Each entry is the slot the most recent send reserved, so
 * overlapping sends serialize instead of reading a shared stale timestamp.
 */
const lastSendAtByAccount = new Map<string, number>();

/** Resolve the inclusive [min, max] bounds, clamping/normalizing bad input. */
function paceBounds(pacing: NonNullable<OcxConfig["codexRequestPacing"]>): { min: number; max: number } {
  const rawMin = typeof pacing.minMs === "number" && Number.isFinite(pacing.minMs) ? pacing.minMs : PACE_DEFAULT_MIN_MS;
  const rawMax = typeof pacing.maxMs === "number" && Number.isFinite(pacing.maxMs) ? pacing.maxMs : PACE_DEFAULT_MAX_MS;
  const min = Math.max(0, Math.min(rawMin, rawMax));
  const max = Math.max(min, Math.max(rawMin, rawMax));
  return { min, max };
}

/** Randomized gap in ms within the configured [minMs, maxMs] window. */
function paceGapMs(pacing: NonNullable<OcxConfig["codexRequestPacing"]>): number {
  const { min, max } = paceBounds(pacing);
  return min + Math.random() * (max - min);
}

/** Reset all pacer state. Intended for deterministic tests. */
export function resetCodexPacerState(): void {
  lastSendAtByAccount.clear();
}

/**
 * Configured Codex pool width used for auto-enable: selectable added accounts
 * plus the main Desktop login candidate (Option A).
 */
export function configuredCodexPoolSize(config: Pick<OcxConfig, "codexAccounts">): number {
  const added = (config.codexAccounts ?? []).filter(isSelectableCodexPoolAccount).length;
  return added + 1;
}

function isRoundRobinPool(
  config: Pick<OcxConfig, "codexRotationMode" | "accountPoolStrategy">,
): boolean {
  if (config.accountPoolStrategy === "round-robin") return true;
  // Fork alias from types.ts: when accountPoolStrategy is unset, codexRotationMode
  // `"round-robin"` means the same thing.
  if (config.accountPoolStrategy == null && config.codexRotationMode === "round-robin") return true;
  return false;
}

/**
 * Resolve the EFFECTIVE pacing config, accounting for auto-enable:
 * when the pool strategy is round-robin and >1 account is configured,
 * pacing defaults to ON (with default bounds) even if codexRequestPacing is unset.
 * Explicit config always wins.
 */
export function resolveEffectivePacing(
  config: Pick<OcxConfig, "codexRequestPacing" | "codexRotationMode" | "accountPoolStrategy">,
  poolSize: number,
): NonNullable<OcxConfig["codexRequestPacing"]> | null {
  const explicit = config.codexRequestPacing;
  if (explicit) {
    // Explicit config wins — respect enabled: true OR false.
    if (!explicit.enabled) return null;
    return { minMs: PACE_DEFAULT_MIN_MS, maxMs: PACE_DEFAULT_MAX_MS, ...explicit };
  }
  // No explicit config: auto-enable for multi-account round-robin pools
  // (reduces ban-prone cadence alignment across accounts).
  if (isRoundRobinPool(config) && poolSize > 1) {
    return { enabled: true, minMs: PACE_DEFAULT_MIN_MS, maxMs: PACE_DEFAULT_MAX_MS };
  }
  return null;
}

/**
 * Await the per-account jittered gap before an outbound Codex pool send.
 * No-op (no await) when pacing is disabled or no account id is supplied.
 *
 * When `signal` aborts (client disconnect), the wait resolves immediately so a
 * cancelled request never sits in the pacing queue. The reserved slot is kept:
 * later senders still pace off it, preserving their ordering. Callers must
 * check the signal after awaiting and skip the upstream send when aborted.
 */
export async function codexPaceBeforeSend(
  config: OcxConfig,
  accountId: string | null,
  poolSize?: number,
  signal?: AbortSignal,
): Promise<void> {
  const effective = poolSize !== undefined
    ? resolveEffectivePacing(config, poolSize)
    : (config.codexRequestPacing?.enabled
      ? { enabled: true, minMs: PACE_DEFAULT_MIN_MS, maxMs: PACE_DEFAULT_MAX_MS, ...config.codexRequestPacing }
      : null);
  if (!effective) return;
  if (!accountId) return;
  const now = Date.now();
  const last = lastSendAtByAccount.get(accountId);
  // Reserve the next send slot synchronously — BEFORE any await — so
  // overlapping sends for the same account serialize. Each caller paces off
  // the previous reservation; recording after the wait would let concurrent
  // callers read the same stale timestamp and proceed together with no gap.
  const sendAt = last === undefined ? now : Math.max(now, last + paceGapMs(effective));
  lastSendAtByAccount.set(accountId, sendAt);
  const wait = sendAt - now;
  if (wait <= 0) return;
  if (signal?.aborted) return;
  await new Promise<void>(resolve => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, wait);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
