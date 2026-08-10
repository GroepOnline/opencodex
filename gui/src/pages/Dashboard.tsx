import { useEffect, useMemo, useState } from "react";
import { useKeyedClientResource } from "../client-resource";
import { useT, useI18n } from "../i18n/shared";
import { formatTokens } from "../format-tokens";
import { statusCodeInfo } from "../status-codes";
import { modelLabel } from "../model-display";
import { IconCheck, IconAlert } from "../icons";

interface Healthz {
  status: string;
  service: string;
  version: string;
  uptime: number;
  pid: number;
  port: number;
}

interface BonEntry {
  requestId?: string;
  timestamp: number;
  model: string;
  provider: string;
  status: number;
  durationMs: number;
  errorCode?: string;
  upstreamError?: string;
  totalTokens?: number;
  usage?: { inputTokens: number; outputTokens: number; totalTokens?: number };
}

interface UsageSummary {
  summary: { requests: number; totalTokens: number };
  days: Array<{ date: string; requests: number; totalTokens?: number }>;
}

function vandaagKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function bonTokens(entry: BonEntry): number | undefined {
  if (entry.usage) return entry.usage.totalTokens ?? entry.usage.inputTokens + entry.usage.outputTokens;
  return entry.totalTokens;
}

function tijd(ts: number, locale: string): string {
  return new Date(ts).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Dashboard: enterprise landing — proxy health, usage stats, top providers, recent activity. */
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
          if (!cancelled) setSummary(data);
        }
        if (logsRes.ok) {
          const data = (await logsRes.json()) as BonEntry[];
          if (!cancelled) setLogs(Array.isArray(data) ? data.toSorted((a, b) => b.timestamp - a.timestamp) : []);
        }
      } catch { /* keep last-good */ }
    };
    void load();
    const iv = setInterval(() => void load(), 30_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [apiBase]);

  const requestsVandaag = useMemo(() => {
    const key = vandaagKey();
    return summary?.days.find(d => d.date === key)?.requests ?? 0;
  }, [summary]);

  const requests30d = summary?.summary.requests ?? 0;
  const tokens30d = summary?.summary.totalTokens ?? 0;

  /** Provider usage ranking (top 5 by request count). */
  const providerRanks = useMemo(() => {
    const map: Record<string, number> = {};
    for (const log of logs) {
      map[log.provider] = (map[log.provider] ?? 0) + 1;
    }
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
  }, [logs]);

  /* Last 8 bon entries for the live feed */
  const recentBons = useMemo(() => logs.slice(0, 8), [logs]);

  const proxyOnline = health.data ? true : health.error ? false : null;

  return (
    <>
      <div className="page-head">
        <h2>{t("nav.dashboard")}</h2>
      </div>

      {/* Health strip */}
      <div className="pws-dashboard-summary" style={{ marginBottom: 24 }}>
        <div className="pws-dashboard-card pws-dashboard-card--ok">
          {proxyOnline === null ? (
            <span className="pws-dashboard-card-count spin" aria-label={t("common.loading")} />
          ) : (
            <span className="pws-dashboard-card-count">
              {proxyOnline ? <IconCheck size={18} aria-hidden /> : <IconAlert size={18} aria-hidden />}
            </span>
          )}
          <span className="pws-dashboard-card-label">
            {proxyOnline === null ? t("common.loading") : proxyOnline ? t("proxy.online") : t("proxy.offline")}
          </span>
        </div>
        {health.data && (
          <>
            <div className="pws-dashboard-card pws-dashboard-card--muted">
              <span className="pws-dashboard-card-count" style={{ fontSize: "1rem" }}>{health.data.version}</span>
              <span className="pws-dashboard-card-label">{t("dash.version")}</span>
            </div>
            <div className="pws-dashboard-card pws-dashboard-card--muted">
              <span className="pws-dashboard-card-count" style={{ fontSize: "1rem" }}>{formatUptime(health.data.uptime)}</span>
              <span className="pws-dashboard-card-label">{t("dash.uptime")}</span>
            </div>
            <div className="pws-dashboard-card pws-dashboard-card--muted">
              <span className="pws-dashboard-card-count" style={{ fontSize: "1rem" }}>{health.data.pid}</span>
              <span className="pws-dashboard-card-label">PID</span>
            </div>
          </>
        )}
      </div>

      {/* Usage stats */}
      <div className="stat-strip" role="group" aria-label={t("vk.statsAria")} style={{ marginBottom: 24 }}>
        <div className="stat-strip-item">
          <span className="stat-strip-waarde">{formatTokens(tokens30d, locale)}</span>
          <span className="stat-strip-label">{t("vk.tokens30d")}</span>
        </div>
        <div className="stat-strip-item">
          <span className="stat-strip-waarde">{requestsVandaag.toLocaleString(locale)}</span>
          <span className="stat-strip-label">{t("vk.requestsToday")}</span>
        </div>
        <div className="stat-strip-item">
          <span className="stat-strip-waarde">{requests30d.toLocaleString(locale)}</span>
          <span className="stat-strip-label">{t("vk.requests30d")}</span>
        </div>
      </div>

      <div className="pws-dashboard-columns">
        {/* Top providers */}
        <section className="pws-dashboard-section pws-dashboard-section--recent"
          aria-label={t("dash.providers")}>
          <h3 className="pws-dashboard-section-title">{t("dash.providers")}</h3>
          {providerRanks.length > 0 ? (
            <div className="pws-dashboard-rows">
              {providerRanks.map(([name, count]) => (
                <div key={name} className="pws-dashboard-row">
                  <span className="pws-dashboard-row-name">{name}</span>
                  <span className="pws-dashboard-row-count muted">
                    {t("pws.dashboard.requests", { count: count.toLocaleString(locale) })}
                  </span>
                  {/* Mini bar */}
                  <span className="dash-bar-track" aria-hidden="true">
                    <span className="dash-bar-fill" style={{ width: `${(count / providerRanks[0][1]) * 100}%` }} />
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted pws-dashboard-empty">{t("pws.dashboard.noUsage")}</p>
          )}
        </section>

        {/* Recent traffic */}
        <section className="pws-dashboard-section pws-dashboard-section--rate-limits"
          aria-label={t("nav.usage")}>
          <h3 className="pws-dashboard-section-title">{t("nav.usage")}</h3>
          {recentBons.length > 0 ? (
            <div className="pws-dashboard-rows" style={{ gap: 0 }}>
              {recentBons.map(entry => {
                const id = entry.requestId ?? `${entry.timestamp}-${entry.provider}-${entry.model}`;
                const tokens = bonTokens(entry);
                const statusInfo = statusCodeInfo(entry.status, locale);
                const stempelCls = entry.status >= 200 && entry.status < 300 ? "stempel--klaar" : "stempel--fout";
                return (
                  <div key={id} className="bon" style={{ borderBottom: "1px solid var(--border-soft)" }}>
                    <div className="bon-kop" style={{ padding: "6px 8px", display: "flex", gap: 8, alignItems: "center", fontSize: "0.8125rem" }}>
                      <span className="bon-tijd">{tijd(entry.timestamp, locale)}</span>
                      <span className="bon-titel" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {modelLabel(entry.model)}
                      </span>
                      <span className="bon-meta">{entry.provider}</span>
                      {tokens !== undefined && <span className="bon-meta">{t("vk.rowTokens", { n: formatTokens(tokens, locale) })}</span>}
                      <span className={`stempel ${stempelCls}`}>{statusInfo?.label ?? entry.status}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="muted pws-dashboard-empty">{t("vk.empty")}</p>
          )}
        </section>
      </div>
    </>
  );
}
