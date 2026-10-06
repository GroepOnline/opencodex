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
    {
      id: "proxy",
      labelKey: "health.row.proxy",
      status:
        proxyOnline === null ? "unknown" : proxyOnline ? "healthy" : "degraded",
      detailKey:
        proxyOnline && proxyVersion
          ? "health.detail.proxyOnline"
          : proxyOnline === false
            ? "health.detail.proxyOffline"
            : "health.detail.pending",
      detailVars:
        proxyOnline && proxyVersion && typeof proxyUptime === "number"
          ? { version: proxyVersion, uptime: formatUptime(proxyUptime, locale) }
          : undefined,
    },
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
      detailKey:
        data.routingKind === "opencodex-local"
          ? "health.detail.routingProxy"
          : data.routingKind === "native"
            ? "health.detail.routingNative"
            : data.routingKind === "custom-local"
              ? "health.detail.routingCustomLocal"
              : data.routingKind === "custom-remote"
                ? "health.detail.routingCustomRemote"
                : "health.detail.routingUnknown",
    },
    {
      id: "service",
      labelKey: "health.row.restartService",
      status: diagnosticUnavailable ? "unknown" : serviceStatus(data),
      detailKey: diagnosticUnavailable
        ? "health.detail.mgmtStale"
        : !data.serviceSupported
          ? "health.detail.serviceUnsupported"
          : data.serviceViable
            ? "health.detail.serviceViable"
            : data.serviceConflict
              ? "health.detail.serviceConflict"
              : data.serviceStale
                ? "health.detail.serviceStale"
                : data.serviceInstalled
                  ? "health.detail.serviceUnhealthy"
                  : "health.detail.serviceMissing",
    },
    {
      id: "shim",
      labelKey: "health.row.autostartShim",
      status: diagnosticUnavailable ? "unknown" : shimStatus(data),
      detailKey: diagnosticUnavailable
        ? "health.detail.mgmtStale"
        : !data.shimInstalled
          ? "health.detail.shimMissing"
          : data.shimHealthy && data.autostartEnabled
            ? "health.detail.shimHealthy"
            : data.shimHealthy
              ? "health.detail.shimDisabled"
              : "health.detail.shimStale",
    },
  ];

  if (data.platform === "win32") {
    rows.push({
      id: "tray",
      labelKey: "health.row.windowsTray",
      status: trayStatus(tray, trayLoading, trayError),
      detailKey: trayLoading
        ? "health.detail.trayLoading"
        : trayError || !tray
          ? "health.detail.trayUnavailable"
          : tray.running && !tray.stale
            ? "health.detail.trayRunning"
            : tray.stale
              ? "health.detail.trayStale"
              : tray.installed
                ? "health.detail.trayStopped"
                : "health.detail.trayMissing",
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
