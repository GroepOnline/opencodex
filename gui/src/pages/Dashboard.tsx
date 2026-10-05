import { useEffect, useMemo, useState } from "react";
import { useKeyedClientResource } from "../client-resource";
import { formatTokens } from "../format-tokens";
import { useI18n, useT } from "../i18n/shared";
import { requestsTodayCount, type TrafficLogEntry } from "../traffic-shared";
import MetricList from "../components/MetricList";
import {
  ProviderUsageList,
  type ProviderUsageItem,
} from "../components/dashboard/provider-usage-list";
import { RequestActivityList } from "../components/dashboard/request-activity-list";
import {
  RuntimeSummary,
  type RuntimeHealth,
} from "../components/dashboard/runtime-summary";
import { PageHeader } from "../components/primitives/page-header";

interface UsageProviderRow extends ProviderUsageItem {
  totalTokens: number;
}

interface UsageSummary {
  summary: {
    requests: number;
    totalTokens: number;
    estimatedCostUsd?: number;
    coverageRatio?: number;
    ratio429?: number;
    ratio502?: number;
    p95LatencyMs: number;
    p95TtftMs: number;
  };
  days: Array<{ date: string; requests: number; totalTokens?: number }>;
  providers: UsageProviderRow[];
}

const EMPTY_TRAFFIC_LOGS: TrafficLogEntry[] = [];

/** Formats a 0..1 ratio as a rounded percentage; em-dash when absent. */
function formatRatio(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(value * 100)}%`
    : "—";
}

/**
 * Displays proxy health, usage statistics, provider rankings, and recent traffic activity.
 * Page code owns data fetching and composition only; visible semantics live in components.
 */
export default function Dashboard({ apiBase }: { apiBase: string }) {
  const t = useT();
  const { locale } = useI18n();

  const health = useKeyedClientResource<RuntimeHealth | null>(
    `dash-healthz:${apiBase}`,
    [],
    async (signal) => {
      const res = await fetch(`${apiBase}/healthz`, { signal });
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as RuntimeHealth;
    },
    { pollMs: 15_000 },
  );

  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [summarySource, setSummarySource] = useState<string | null>(null);
  const [logs, setLogs] = useState<TrafficLogEntry[]>([]);
  const [logsSource, setLogsSource] = useState<string | null>(null);
  const [usageFailed, setUsageFailed] = useState(false);
  const [usageFailureSource, setUsageFailureSource] = useState<string | null>(
    null,
  );
  const [logsFailed, setLogsFailed] = useState(false);
  const [logsFailureSource, setLogsFailureSource] = useState<string | null>(
    null,
  );
  const [logsLoaded, setLogsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [usageResult, logsResult] = await Promise.allSettled([
        (async () => {
          const res = await fetch(`${apiBase}/api/usage?range=30d`);
          if (!res.ok) throw new Error(String(res.status));
          return (await res.json()) as UsageSummary;
        })(),
        (async () => {
          const res = await fetch(`${apiBase}/api/logs`);
          if (!res.ok) throw new Error(String(res.status));
          return (await res.json()) as TrafficLogEntry[];
        })(),
      ]);

      if (cancelled) return;
      if (usageResult.status === "fulfilled") {
        setSummary(usageResult.value);
        setSummarySource(apiBase);
        setUsageFailed(false);
        setUsageFailureSource(null);
      } else {
        setUsageFailed(true);
        setUsageFailureSource(apiBase);
      }

      if (logsResult.status === "fulfilled") {
        const data = logsResult.value;
        setLogs(
          Array.isArray(data)
            ? data.toSorted((a, b) => b.timestamp - a.timestamp)
            : [],
        );
        setLogsSource(apiBase);
        setLogsFailed(false);
        setLogsFailureSource(null);
        setLogsLoaded(true);
      } else {
        setLogsFailed(true);
        setLogsFailureSource(apiBase);
      }
    };

    void load();
    const iv = setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [apiBase]);

  const currentSummary = summarySource === apiBase ? summary : null;
  const currentLogs = logsSource === apiBase ? logs : EMPTY_TRAFFIC_LOGS;
  const currentUsageFailed =
    usageFailed && usageFailureSource === apiBase;
  const currentLogsFailed = logsFailed && logsFailureSource === apiBase;
  const currentLogsLoaded = logsLoaded && logsSource === apiBase;

  const requestsToday = useMemo(
    () => requestsTodayCount(currentLogs, currentSummary?.days),
    [currentLogs, currentSummary],
  );

  const providers = useMemo(
    () =>
      (currentSummary?.providers ?? [])
        .toSorted((a, b) => b.requests - a.requests)
        .slice(0, 5),
    [currentSummary],
  );

  const recentRequests = useMemo(() => currentLogs.slice(0, 8), [currentLogs]);
  const proxyOnline = health.data ? true : health.error ? false : null;
  const requests30d = currentSummary?.summary.requests ?? 0;
  const tokens30d = currentSummary?.summary.totalTokens ?? 0;

  const costUsd =
    typeof currentSummary?.summary.estimatedCostUsd === "number" &&
    Number.isFinite(currentSummary.summary.estimatedCostUsd)
      ? new Intl.NumberFormat(locale, {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 2,
        }).format(currentSummary.summary.estimatedCostUsd)
      : "—";

  return (
    <div className="dashboard-workspace ocx-page-root">
      <PageHeader
        title={t("nav.dashboard")}
        description={t("dash.subtitle")}
        actions={
          <>
            <a className="btn btn-ghost btn-sm" href="#verkeer">
              {t("nav.verkeer")}
            </a>
            <a className="btn btn-ghost btn-sm" href="#leveranciers">
              {t("nav.providers")}
            </a>
          </>
        }
      />

      <RuntimeSummary
        health={health.data ?? null}
        online={proxyOnline}
        locale={locale}
        labels={{
          aria: t("dash.healthAria"),
          loading: t("common.loading"),
          status: t("dash.status"),
          online: t("proxy.online"),
          offline: t("proxy.offline"),
          version: t("dash.version"),
          uptime: t("dash.uptime"),
          pid: t("dash.pid"),
          cooldown: t("dash.cooldown"),
          cooldownHint: (count) =>
            t("dash.cooldownHint", { count: String(count) }),
        }}
      />

      <MetricList
        label={t("vk.statsAria")}
        metrics={[
          {
            label: t("vk.tokens30d"),
            value: currentSummary ? formatTokens(tokens30d, locale) : "—",
          },
          {
            label: t("vk.requestsToday"),
            value:
              currentSummary || currentLogsLoaded
                ? requestsToday.toLocaleString(locale)
                : "—",
          },
          {
            label: t("vk.requests30d"),
            value: currentSummary ? requests30d.toLocaleString(locale) : "—",
          },
          { label: t("vk.costUsd"), value: costUsd },
          {
            label: t("dash.coverageLabel"),
            value: formatRatio(currentSummary?.summary.coverageRatio),
          },
          {
            label: t("dash.http429"),
            value: formatRatio(currentSummary?.summary.ratio429),
          },
          {
            label: t("dash.http50x"),
            value: formatRatio(currentSummary?.summary.ratio502),
          },
        ]}
      />

      <div className="pws-dashboard-columns">
        <ProviderUsageList
          providers={providers}
          locale={locale}
          failed={currentUsageFailed}
          loaded={currentSummary !== null}
          labels={{
            title: t("dash.providers"),
            loadError: t("usage.loadError"),
            loading: t("common.loading"),
            emptyTitle: t("dash.providersEmptyTitle"),
            empty: t("pws.dashboard.noUsage"),
            viewAll: t("dash.viewAll"),
            providersNav: t("nav.providers"),
            requestOne: t("pws.dashboard.requestOne"),
            requests: (count) => t("pws.dashboard.requests", { count }),
          }}
        />

        <RequestActivityList
          entries={recentRequests}
          locale={locale}
          failed={currentLogsFailed}
          loaded={currentLogsLoaded}
          labels={{
            title: t("nav.verkeer"),
            loadError: t("vk.loadFailed"),
            loading: t("common.loading"),
            emptyTitle: t("dash.trafficEmptyTitle"),
            empty: t("dash.trafficEmptyDesc"),
            viewAll: t("dash.viewAll"),
          }}
        />
      </div>
    </div>
  );
}
