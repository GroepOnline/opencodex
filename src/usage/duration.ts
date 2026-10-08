/** Hard ceiling for a single request duration. Absolute timestamps fail this check. */
export const USAGE_DURATION_HARD_MAX_MS = 60 * 60 * 1000;

export type UsageDurationRejectReason =
  "invalid" | "invalid_clock" | "exceeds_cap";

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

/** Emit a duration rejection as a JSON warning. */
function defaultWarn(payload: UsageDurationWarning): void {
  console.warn(JSON.stringify(payload));
}

/** Return process uptime in milliseconds, or zero if it is not finite and positive. */
function processUptimeMs(): number {
  const uptime = process.uptime();
  return Number.isFinite(uptime) && uptime > 0 ? uptime * 1000 : 0;
}

/**
 * Reject a duration that is not a plausible elapsed time.
 *
 * Return finite, nonnegative milliseconds unchanged up to the inclusive cap:
 * the smaller of `maxMs` (default one hour) and nonnegative `uptimeMs` plus
 * 1,000 ms of slack. Uptime defaults to the current process uptime.
 * With default options, absolute timestamps such as `Date.now()` are rejected.
 * Rejected values become `0`; the warning carries only scalars — never request
 * ids, paths, providers, or secrets. Errors from `options.warn` propagate.
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
 * Return elapsed milliseconds between wall-clock timestamps in milliseconds.
 * `now` defaults to `Date.now()`. Non-finite timestamps, negative elapsed time,
 * or durations exceeding process uptime plus 1,000 ms or one hour produce `0`.
 */
export function elapsedUsageDurationMs(
  startedAt: number,
  now = Date.now(),
): number {
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
