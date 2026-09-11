import { IconAlert, IconCheck } from "../../icons";
import { formatUptime } from "../../formatUptime";

export interface RuntimeHealth {
  status: string;
  service: string;
  version: string;
  uptime: number;
  pid: number;
  port: number;
  providerCooldowns?: number;
}

export function RuntimeSummary({
  health,
  online,
  locale,
  labels,
}: {
  health: RuntimeHealth | null;
  online: boolean | null;
  locale: string;
  labels: {
    aria: string;
    loading: string;
    online: string;
    offline: string;
    version: string;
    uptime: string;
    pid: string;
    cooldown: string;
    cooldownHint: (count: number) => string;
  };
}) {
  return (
    <div
      className="pws-dashboard-stats pws-dashboard-stats--fit"
      role="group"
      aria-label={labels.aria}
    >
      <div className="pws-dashboard-stat">
        {online === null ? (
          <span
            className="pws-dashboard-stat-count spin"
            aria-label={labels.loading}
          />
        ) : (
          <span className="pws-dashboard-stat-count">
            {online ? (
              <IconCheck size={18} aria-hidden />
            ) : (
              <IconAlert size={18} aria-hidden />
            )}
          </span>
        )}
        <span className="pws-dashboard-stat-label caps">
          {online === null ? labels.loading : online ? labels.online : labels.offline}
        </span>
      </div>

      {health ? (
        <>
          <div className="pws-dashboard-stat">
            <span className="pws-dashboard-stat-count num">{health.version}</span>
            <span className="pws-dashboard-stat-label caps">{labels.version}</span>
          </div>
          <div className="pws-dashboard-stat">
            <span className="pws-dashboard-stat-count num">
              {formatUptime(health.uptime, locale)}
            </span>
            <span className="pws-dashboard-stat-label caps">{labels.uptime}</span>
          </div>
          <div className="pws-dashboard-stat">
            <span className="pws-dashboard-stat-count num">{health.pid}</span>
            <span className="pws-dashboard-stat-label caps">{labels.pid}</span>
          </div>
          {(health.providerCooldowns ?? 0) > 0 ? (
            <div
              className="pws-dashboard-stat"
              title={labels.cooldownHint(health.providerCooldowns ?? 0)}
            >
              <span
                className="pws-dashboard-stat-count num"
                style={{
                  color: "var(--amber)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <IconAlert size={13} aria-hidden />
                {health.providerCooldowns}
              </span>
              <span className="pws-dashboard-stat-label caps">{labels.cooldown}</span>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
