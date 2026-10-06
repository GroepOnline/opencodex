/** Canonical operational status semantics — maps to CSS tokens in styles.css. */

export type OperationalStatus =
  | "healthy"
  | "degraded"
  | "rate-limited"
  | "cooldown"
  | "expired"
  | "auth-failed"
  | "disabled"
  | "unknown";

const STATUS_BADGE_CLASS: Record<OperationalStatus, string> = {
  healthy: "badge badge-status-healthy",
  degraded: "badge badge-status-degraded",
  "rate-limited": "badge badge-status-rate-limited",
  cooldown: "badge badge-status-cooldown",
  expired: "badge badge-status-expired",
  "auth-failed": "badge badge-status-auth-failed",
  disabled: "badge badge-status-disabled",
  unknown: "badge badge-status-unknown",
};

export function statusBadgeClass(status: OperationalStatus): string {
  return STATUS_BADGE_CLASS[status];
}
