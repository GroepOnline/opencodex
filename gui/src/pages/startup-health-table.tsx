import { useI18n, type TKey } from "../i18n/shared";
import { formatUptime } from "../formatUptime";
import { StatusBadge } from "../ui";
import type { OperationalStatus } from "../design-tokens";
import type { StartupHealthData, TrayStatusData } from "./startup-shared";

interface HealthRow {
  id: string;
  labelKey: TKey;
  status: OperationalStatus;
  detailKey: TKey;
  detailVars?: Record<string, string | number>;
}

function routingStatus(
  data: StartupHealthData,
  failed: boolean,
): OperationalStatus {
  if (failed || data.status === "at-risk") return "degraded";
  if (data.status === "protected") return "healthy";
  return "unknown";
}

function serviceStatus(data: StartupHealthData): OperationalStatus {
  if (!data.serviceSupported) return "disabled";
  if (data.serviceViable) return "healthy";
  if (data.serviceConflict) return "degraded";
  if (!data.serviceInstalled) return "unknown";
  return "degraded";
}

function shimStatus(data: StartupHealthData): OperationalStatus {
  if (!data.shimInstalled) return "unknown";
  if (data.shimHealthy && data.autostartEnabled) return "healthy";
  if (data.shimHealthy) return "cooldown";
  return "degraded";
}

function trayStatus(
  tray: TrayStatusData | null,
  trayLoading: boolean,
  trayError: boolean,
): OperationalStatus {
  if (trayLoading || trayError || !tray) return "unknown";
  if (tray.running && !tray.stale) return "healthy";
  if (tray.stale) return "degraded";
  if (tray.installed) return "cooldown";
  return "unknown";
}

const ROUTING_DETAILS: Record<StartupHealthData["routingKind"], TKey> = {
  "opencodex-local": "health.detail.routingProxy",
  native: "health.detail.routingNative",
  "custom-local": "health.detail.routingCustomLocal",
  "custom-remote": "health.detail.routingCustomRemote",
  unknown: "health.detail.routingUnknown",
};
function serviceDetail(data: StartupHealthData): TKey {
  if (!data.serviceSupported) return "health.detail.serviceUnsupported";
  if (data.serviceViable) return "health.detail.serviceViable";
  if (data.serviceConflict) return "health.detail.serviceConflict";
  if (data.serviceStale) return "health.detail.serviceStale";
  return data.serviceInstalled
    ? "health.detail.serviceUnhealthy"
    : "health.detail.serviceMissing";
}
function shimDetail(data: StartupHealthData): TKey {
  if (!data.shimInstalled) return "health.detail.shimMissing";
  if (!data.shimHealthy) return "health.detail.shimStale";
  return data.autostartEnabled
    ? "health.detail.shimHealthy"
    : "health.detail.shimDisabled";
}
function trayDetail(
  tray: TrayStatusData | null,
  loading: boolean,
  error: boolean,
): TKey {
  if (loading) return "health.detail.trayLoading";
  if (error || !tray) return "health.detail.trayUnavailable";
  if (tray.stale) return "health.detail.trayStale";
  if (tray.running) return "health.detail.trayRunning";
  return tray.installed
    ? "health.detail.trayStopped"
    : "health.detail.trayMissing";
}
function proxyRow(
  online: boolean | null,
  version: string | undefined,
  uptime: number | undefined,
  locale: string,
): HealthRow {
  const observed =
    online === true && version !== undefined && uptime !== undefined;
  return {
    id: "proxy",
    labelKey: "health.row.proxy",
    status: online === null ? "unknown" : online ? "healthy" : "degraded",
    detailKey: observed
      ? "health.detail.proxyOnline"
      : online === false
        ? "health.detail.proxyOffline"
        : "health.detail.pending",
    detailVars: observed
      ? { version, uptime: formatUptime(uptime, locale) }
      : undefined,
  };
}

export function StartupHealthTable({
  data,
  failed,
  proxyVersion,
  proxyUptime,
  proxyOnline,
  tray,
  trayLoading,
  trayError,
}: {
  data: StartupHealthData;
  failed: boolean;
  proxyVersion?: string;
  proxyUptime?: number;
  proxyOnline: boolean | null;
  tray: TrayStatusData | null;
  trayLoading: boolean;
  trayError: boolean;
}) {
  const { t, locale } = useI18n();
  const diagnosticUnavailable = failed || data.diagnosticStale;

  const rows: HealthRow[] = [
    proxyRow(proxyOnline, proxyVersion, proxyUptime, locale),
    {
      id: "mgmt",
      labelKey: "health.row.mgmtApi",
      status: failed ? "degraded" : "healthy",
      detailKey: failed ? "health.detail.mgmtStale" : "health.detail.mgmtOk",
    },
    {
      id: "routing",
      labelKey: "health.row.routing",
      status: routingStatus(data, diagnosticUnavailable),
      detailKey: ROUTING_DETAILS[data.routingKind],
    },
    {
      id: "service",
      labelKey: "health.row.restartService",
      status: diagnosticUnavailable ? "unknown" : serviceStatus(data),
      detailKey: diagnosticUnavailable
        ? "health.detail.mgmtStale"
        : serviceDetail(data),
    },
    {
      id: "shim",
      labelKey: "health.row.autostartShim",
      status: diagnosticUnavailable ? "unknown" : shimStatus(data),
      detailKey: diagnosticUnavailable
        ? "health.detail.mgmtStale"
        : shimDetail(data),
    },
  ];

  if (data.platform === "win32") {
    rows.push({
      id: "tray",
      labelKey: "health.row.windowsTray",
      status: trayStatus(tray, trayLoading, trayError),
      detailKey: trayDetail(tray, trayLoading, trayError),
    });
  }

  rows.push({
    id: "persistence",
    labelKey: "health.row.persistence",
    status: "unknown",
    detailKey: "health.detail.persistenceUnknown",
  });

  return (
    <section
      className="panel health-truth-table"
      aria-label={t("health.tableAria")}
    >
      <div className="panel-head">
        <h3 className="panel-title">{t("health.tableTitle")}</h3>
      </div>
      <div className="tbl-wrap health-truth-table__wrap">
        <table className="tbl health-truth-table__tbl">
          <thead>
            <tr>
              <th>{t("health.col.component")}</th>
              <th>{t("health.col.status")}</th>
              <th>{t("health.col.cause")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{t(row.labelKey)}</td>
                <td>
                  <StatusBadge status={row.status}>
                    {t(`health.status.${row.status}` as TKey)}
                  </StatusBadge>
                </td>
                <td className="muted">{t(row.detailKey, row.detailVars)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
