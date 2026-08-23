/** Hard ceiling for a single request duration. Absolute timestamps fail this check. */
export const USAGE_DURATION_HARD_MAX_MS = 60 * 60 * 1000;

export type UsageDurationRejectReason = "invalid" | "invalid_clock" | "exceeds_cap";

export interface UsageDurationWarning {
  event: "usage_duration_rejected";
  reason: UsageDurationRejectReason;
  durationMs: number | null;
  capMs: number;
  uptimeMs: number;
}

export interface SanitizeUsageDurationOptions {
  /** Override process uptime (ms). Tests pass a fixed value; persist uses the hard max. */
  uptimeMs?: number;
  maxMs?: number;
  warn?: (payload: UsageDurationWarning) => void;
}

function defaultWarn(payload: UsageDurationWarning): void {
  console.warn(JSON.stringify(payload));
}

function processUptimeMs(): number {
  const uptime = process.uptime();
  return Number.isFinite(uptime) && uptime > 0 ? uptime * 1000 : 0;
}

/**
 * Reject a duration that is not a plausible elapsed time.
 *
 * A request cannot outlive the process (plus 1s of clock slack) or the 1-hour hard max.
 * Values the size of `Date.now()` fail both checks. Invalid values become `0`; the warning
 * carries only scalars — never request ids, paths, providers, or secrets.
 */
export function sanitizeUsageDurationMs(
  durationMs: number,
  options: SanitizeUsageDurationOptions = {},
): number {
  const warn = options.warn ?? defaultWarn;
  const uptimeMs = options.uptimeMs ?? processUptimeMs();
  const maxMs = options.maxMs ?? USAGE_DURATION_HARD_MAX_MS;
  const capMs = Math.min(maxMs, Math.max(0, uptimeMs) + 1_000);
  const roundedUptime = Math.round(uptimeMs);

  if (!Number.isFinite(durationMs) || durationMs < 0) {
    warn({
      event: "usage_duration_rejected",
      reason: "invalid",
      durationMs: Number.isFinite(durationMs) ? durationMs : null,
      capMs,
      uptimeMs: roundedUptime,
    });
    return 0;
  }
  if (durationMs > capMs) {
    warn({
      event: "usage_duration_rejected",
      reason: "exceeds_cap",
      durationMs,
      capMs,
      uptimeMs: roundedUptime,
    });
    return 0;
  }
  return durationMs;
}

/**
 * Elapsed milliseconds from `startedAt` to `now`. Never returns a wall-clock timestamp.
 */
export function elapsedUsageDurationMs(startedAt: number, now = Date.now()): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) {
    defaultWarn({
      event: "usage_duration_rejected",
      reason: "invalid_clock",
      durationMs: null,
      capMs: Math.min(USAGE_DURATION_HARD_MAX_MS, processUptimeMs() + 1_000),
      uptimeMs: Math.round(processUptimeMs()),
    });
    return 0;
  }
  return sanitizeUsageDurationMs(now - startedAt);
}
