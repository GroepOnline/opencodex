import { formatUptime } from "../../formatUptime";
import type { Locale } from "../../i18n/shared";
import { Spinner } from "../primitives/spinner";
import { StatusDot } from "../primitives/status";
import { StatStrip, StatStripItem } from "../primitives/stat-strip";

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
  locale: Locale;
  labels: {
    aria: string;
    loading: string;
    status: string;
    online: string;
    offline: string;
    version: string;
    uptime: string;
    pid: string;
    cooldown: string;
    cooldownHint: (count: number) => string;
  };
}) {
  const statusTone =
    online === true ? "success" : online === false ? "error" : "neutral";
  const statusValue =
    online === null ? labels.loading : online ? labels.online : labels.offline;

  return (
    <StatStrip label={labels.aria} className="stat-strip dash-runtime-strip">
      <div className="stat-strip-item dash-runtime-status">
        <span className="stat-strip-waarde">
          {online === null ? (
            <Spinner aria-label={labels.loading} />
          ) : (
            <StatusDot tone={statusTone} />
          )}
          {statusValue}
        </span>
        <span className="stat-strip-label">{labels.status}</span>
      </div>

      {health ? (
        <>
          <StatStripItem label={labels.version} value={health.version} />
          <StatStripItem
            label={labels.uptime}
            value={formatUptime(health.uptime, locale)}
          />
          <StatStripItem label={labels.pid} value={health.pid} />
          {(health.providerCooldowns ?? 0) > 0 ? (
            <div
              className="stat-strip-item"
              title={labels.cooldownHint(health.providerCooldowns ?? 0)}
            >
              <span className="stat-strip-waarde dash-runtime-cooldown">
                {health.providerCooldowns}
              </span>
              <span className="stat-strip-label">{labels.cooldown}</span>
            </div>
          ) : null}
        </>
      ) : null}
    </StatStrip>
  );
}
