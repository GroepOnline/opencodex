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
  const [logs, setLogs] = useState<TrafficLogEntry[]>([]);
  const [usageFailed, setUsageFailed] = useState(false);
  const [logsFailed, setLogsFailed] = useState(false);
  const [logsLoaded, setLogsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [usageRes, logsRes] = await Promise.all([
          fetch(`${apiBase}/api/usage?range=30d`),
          fetch(`${apiBase}/api/logs`),
        ]);

        if (usageRes.ok) {
          const data = (await usageRes.json()) as UsageSummary;
          if (!cancelled) {
            setSummary(data);
            setUsageFailed(false);
          }
        } else if (!cancelled) {
          setUsageFailed(true);
        }

        if (logsRes.ok) {
          const data = (await logsRes.json()) as TrafficLogEntry[];
          if (!cancelled) {
            setLogs(
              Array.isArray(data)
                ? data.toSorted((a, b) => b.timestamp - a.timestamp)
                : [],
            );
            setLogsFailed(false);
            setLogsLoaded(true);
          }
        } else if (!cancelled) {
          setLogsFailed(true);
        }
      } catch {
        if (!cancelled) {
          setUsageFailed(true);
          setLogsFailed(true);
        }
      }
    };

    void load();
    const iv = setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [apiBase]);

  const requestsToday = useMemo(
    () => requestsTodayCount(logs, summary?.days),
    [logs, summary],
  );

  const providers = useMemo(
    () =>
      (summary?.providers ?? [])
        .toSorted((a, b) => b.requests - a.requests)
        .slice(0, 5),
    [summary],
  );

  const recentRequests = useMemo(() => logs.slice(0, 8), [logs]);
  const proxyOnline = health.data ? true : health.error ? false : null;
  const requests30d = summary?.summary.requests ?? 0;
  const tokens30d = summary?.summary.totalTokens ?? 0;

  const costUsd =
    typeof summary?.summary.estimatedCostUsd === "number" &&
    Number.isFinite(summary.summary.estimatedCostUsd)
      ? new Intl.NumberFormat(locale, {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 2,
        }).format(summary.summary.estimatedCostUsd)
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
            value: summary ? formatTokens(tokens30d, locale) : "—",
          },
          {
            label: t("vk.requestsToday"),
            value:
              summary || logsLoaded ? requestsToday.toLocaleString(locale) : "—",
          },
          {
            label: t("vk.requests30d"),
            value: summary ? requests30d.toLocaleString(locale) : "—",
          },
          { label: t("vk.costUsd"), value: costUsd },
          {
            label: t("dash.coverageLabel"),
            value: formatRatio(summary?.summary.coverageRatio),
          },
          {
            label: t("dash.http429"),
            value: formatRatio(summary?.summary.ratio429),
          },
          {
            label: t("dash.http50x"),
            value: formatRatio(summary?.summary.ratio502),
          },
        ]}
      />

      <div className="pws-dashboard-columns">
        <ProviderUsageList
          providers={providers}
          locale={locale}
          failed={usageFailed}
          loaded={summary !== null}
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
          failed={logsFailed}
          loaded={logsLoaded}
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
