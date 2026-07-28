import type { OcxConfig } from "../types";

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
 */

const PACE_DEFAULT_MIN_MS = 150;
const PACE_DEFAULT_MAX_MS = 900;

/** Per-account last-send timestamps (ms). Module-level, in-process, non-persistent. */
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
 * Resolve the EFFECTIVE pacing config, accounting for auto-enable:
 * when codexRotationMode === "round-robin" and >1 pool account is configured,
 * pacing defaults to ON (with default bounds) even if codexRequestPacing is unset.
 * Explicit config always wins.
 */
export function resolveEffectivePacing(
  config: Pick<OcxConfig, "codexRequestPacing" | "codexRotationMode">,
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
  if (config.codexRotationMode === "round-robin" && poolSize > 1) {
    return { enabled: true, minMs: PACE_DEFAULT_MIN_MS, maxMs: PACE_DEFAULT_MAX_MS };
  }
  return null;
}

/**
 * Await the per-account jittered gap before an outbound Codex pool send.
 * No-op (no await) when pacing is disabled or no account id is supplied.
 */
export async function codexPaceBeforeSend(config: OcxConfig, accountId: string | null, poolSize?: number): Promise<void> {
  const effective = poolSize !== undefined
    ? resolveEffectivePacing(config, poolSize)
    : (config.codexRequestPacing?.enabled ? { enabled: true, minMs: PACE_DEFAULT_MIN_MS, maxMs: PACE_DEFAULT_MAX_MS, ...config.codexRequestPacing } : null);
  if (!effective) return;
  if (!accountId) return;
  const now = Date.now();
  const last = lastSendAtByAccount.get(accountId);
  if (last !== undefined) {
    const wait = Math.max(0, paceGapMs(effective) - (now - last));
    if (wait > 0) await new Promise<void>(resolve => setTimeout(resolve, wait));
  }
  // Record the actual send time (after any wait) so the next gap measures from
  // the real send cadence rather than the moment we entered the pacer.
  lastSendAtByAccount.set(accountId, Date.now());
}
