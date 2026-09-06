import { useEffect, useMemo, useState } from "react";
import { useKeyedClientResource } from "../client-resource";
import { useT, useI18n } from "../i18n/shared";
import { formatTokens } from "../format-tokens";
import { formatUptime } from "../formatUptime";
import { TrafficRowCells } from "../traffic-row";
import { requestsTodayCount, type TrafficLogEntry } from "../traffic-shared";
import { IconCheck, IconAlert } from "../icons";
import { Notice } from "../ui";
import MetricList from "../components/MetricList";
import {
  Empty,
  EmptyHeader,
  EmptyDescription,
  EmptyContent,
} from "../components/primitives/empty";
import { Button } from "../components/primitives/button";

interface Healthz {
  status: string;
  service: string;
  version: string;
  uptime: number;
  pid: number;
  port: number;
  providerCooldowns?: number;
}

type BonEntry = TrafficLogEntry;

interface UsageProviderRow {
  provider: string;
  requests: number;
  totalTokens: number;
  shareRatio: number;
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

/**
 * Determines the total token count for a traffic entry.
 *
 * @param entry - The traffic entry containing usage or total token data
 * @returns The recorded total tokens, calculated usage tokens, or the entry total tokens
 */
function bonTokens(entry: BonEntry): number | undefined {
  if (entry.usage)
    return (
      entry.usage.totalTokens ??
      entry.usage.inputTokens + entry.usage.outputTokens
    );
  return entry.totalTokens;
}

function tijd(ts: number, locale: string): string {
  return new Date(ts).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Formats a 0..1 ratio as a rounded percentage; em-dash when absent. */
function formatRatio(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(value * 100)}%`
    : "—";
}

/**
 * Displays proxy health, usage statistics, provider rankings, and recent traffic activity.
 *
 * @param apiBase - Base URL used to retrieve proxy health, usage, and traffic data.
 */
export default function Dashboard({ apiBase }: { apiBase: string }) {
  const t = useT();
  const { locale } = useI18n();

  const health = useKeyedClientResource<Healthz | null>(
    `dash-healthz:${apiBase}`,
    [],
    async (signal) => {
      const res = await fetch(`${apiBase}/healthz`, { signal });
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as Healthz;
    },
    { pollMs: 15_000 },
  );

  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [logs, setLogs] = useState<BonEntry[]>([]);
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
          const data = (await logsRes.json()) as BonEntry[];
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

  const requestsVandaag = useMemo(
    () => requestsTodayCount(logs, summary?.days),
    [logs, summary],
  );

  const requests30d = summary?.summary.requests ?? 0;
  const tokens30d = summary?.summary.totalTokens ?? 0;

  /** Provider usage ranking (top 5 by request count, 30d from /api/usage). */
  const usageProviders = useMemo(() => {
    const ps = summary?.providers ?? [];
    return ps.toSorted((a, b) => b.requests - a.requests).slice(0, 5);
  }, [summary]);

  const costUsd =
    typeof summary?.summary.estimatedCostUsd === "number" &&
    Number.isFinite(summary.summary.estimatedCostUsd)
      ? new Intl.NumberFormat(locale, {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 2,
        }).format(summary.summary.estimatedCostUsd)
      : "—";
  const coveragePct = formatRatio(summary?.summary.coverageRatio);
  const pct429 = formatRatio(summary?.summary.ratio429);
  const pct502 = formatRatio(summary?.summary.ratio502);

  /* Last 8 traffic entries for the live feed */
  const recentBons = useMemo(() => logs.slice(0, 8), [logs]);

  const proxyOnline = health.data ? true : health.error ? false : null;

  return (
    <div className="dashboard-workspace">
      <div className="page-head">
        <h2>{t("nav.dashboard")}</h2>
      </div>

      {/* Health strip */}
      <div
        className="pws-dashboard-stats pws-dashboard-stats--fit"
        role="group"
        aria-label={t("dash.healthAria")}
      >
        <div className="pws-dashboard-stat">
          {proxyOnline === null ? (
            <span
              className="pws-dashboard-stat-count spin"
              aria-label={t("common.loading")}
            />
          ) : (
            <span className="pws-dashboard-stat-count">
              {proxyOnline ? (
                <IconCheck size={18} aria-hidden />
              ) : (
                <IconAlert size={18} aria-hidden />
              )}
            </span>
          )}
          <span className="pws-dashboard-stat-label caps">
            {proxyOnline === null
              ? t("common.loading")
              : proxyOnline
                ? t("proxy.online")
                : t("proxy.offline")}
          </span>
        </div>
        {health.data && (
          <>
            <div className="pws-dashboard-stat">
              <span className="pws-dashboard-stat-count num">
                {health.data.version}
              </span>
              <span className="pws-dashboard-stat-label caps">
                {t("dash.version")}
              </span>
            </div>
            <div className="pws-dashboard-stat">
              <span className="pws-dashboard-stat-count num">
                {formatUptime(health.data.uptime, locale)}
              </span>
              <span className="pws-dashboard-stat-label caps">
                {t("dash.uptime")}
              </span>
            </div>
            <div className="pws-dashboard-stat">
              <span className="pws-dashboard-stat-count num">
                {health.data.pid}
              </span>
              <span className="pws-dashboard-stat-label caps">
                {t("dash.pid")}
              </span>
            </div>
            {(health.data.providerCooldowns ?? 0) > 0 && (
              <div
                className="pws-dashboard-stat"
                title={t("dash.cooldownHint", {
                  count: String(health.data.providerCooldowns),
                })}
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
                  {health.data.providerCooldowns}
                </span>
                <span className="pws-dashboard-stat-label caps">
                  {t("dash.cooldown")}
                </span>
              </div>
            )}
          </>
        )}
      </div>

      {/* Usage stats */}
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
              summary || logsLoaded
                ? requestsVandaag.toLocaleString(locale)
                : "—",
          },
          {
            label: t("vk.requests30d"),
            value: summary ? requests30d.toLocaleString(locale) : "—",
          },
          { label: t("vk.costUsd"), value: costUsd },
          {
            label: t("dash.coverageLabel"),
            value: coveragePct,
          },
          { label: t("dash.http429"), value: pct429 },
          { label: t("dash.http50x"), value: pct502 },
        ]}
      />

      <div className="pws-dashboard-columns">
        {/* Top providers */}
        <section
          className="pws-dashboard-section pws-dashboard-section--recent"
          aria-label={t("dash.providers")}
        >
          <h3 className="pws-dashboard-section-title">{t("dash.providers")}</h3>
          {usageFailed && <Notice tone="err">{t("usage.loadError")}</Notice>}
          {usageProviders.length > 0 ? (
            <div className="pws-dashboard-rows">
              {usageProviders.map((p) => {
                const name = p.provider;
                const count = p.requests;
                const sharePct = Number.isFinite(p.shareRatio)
                  ? Math.min(100, Math.max(0, p.shareRatio * 100))
                  : 0;
                return (
                  <div key={name} className="pws-dashboard-row">
                    <span className="pws-dashboard-row-name">{name}</span>
                    <span className="pws-dashboard-row-count muted">
                      {count === 1
                        ? t("pws.dashboard.requestOne")
                        : t("pws.dashboard.requests", {
                            count: count.toLocaleString(locale),
                          })}
                    </span>
                    {/* Mini bar */}
                    <span className="dash-bar-track" aria-hidden="true">
                      <span
                        className="dash-bar-fill"
                        style={{
                          width: `${sharePct}%`,
                        }}
                      />
                    </span>
                  </div>
                );
              })}
            </div>
          ) : !usageFailed ? (
            <Empty>
              <EmptyHeader>
                <EmptyDescription>
                  {t(summary ? "pws.dashboard.noUsage" : "common.loading")}
                </EmptyDescription>
              </EmptyHeader>
              {summary && (
                <EmptyContent>
                  <Button
                    variant="outline"
                    nativeButton={false}
                    render={
                      <a href="#leveranciers" aria-label={t("nav.providers")} />
                    }
                  >
                    {t("nav.providers")}
                  </Button>
                </EmptyContent>
              )}
            </Empty>
          ) : null}
        </section>

        {/* Recent traffic */}
        <section
          className="pws-dashboard-section pws-dashboard-section--rate-limits"
          aria-label={t("nav.verkeer")}
        >
          <h3 className="pws-dashboard-section-title">{t("nav.verkeer")}</h3>
          {logsFailed && <Notice tone="err">{t("vk.loadFailed")}</Notice>}
          {recentBons.length > 0 ? (
            <div className="pws-dashboard-rows" style={{ gap: 0 }}>
              {recentBons.map((entry) => {
                const id =
                  entry.requestId ??
                  `${entry.timestamp}-${entry.provider}-${entry.model}`;
                const tokens = bonTokens(entry);
                return (
                  <div
                    key={id}
                    className="traffic-entry"
                    style={{ borderBottom: "1px solid var(--border-soft)" }}
                  >
                    <div className="traffic-entry-head traffic-entry-head--grid">
                      <span className="traffic-col traffic-col--time traffic-time">
                        {tijd(entry.timestamp, locale)}
                      </span>
                      <TrafficRowCells
                        entry={entry}
                        locale={locale}
                        tokens={tokens}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : !logsFailed ? (
            <Empty>
              <EmptyHeader>
                <EmptyDescription>
                  {t(logsLoaded ? "vk.empty" : "common.loading")}
                </EmptyDescription>
              </EmptyHeader>
              {logsLoaded && (
                <EmptyContent>
                  <Button
                    variant="outline"
                    nativeButton={false}
                    render={<a href="#verkeer" aria-label={t("nav.verkeer")} />}
                  >
                    {t("nav.verkeer")}
                  </Button>
                </EmptyContent>
              )}
            </Empty>
          ) : null}
        </section>
      </div>
    </div>
  );
}
