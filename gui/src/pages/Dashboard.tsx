import { useEffect, useMemo, useState } from "react";
import { useKeyedClientResource } from "../client-resource";
import { useT, useI18n } from "../i18n/shared";
import { formatTokens } from "../format-tokens";
import { formatUptime } from "../formatUptime";
import { TrafficRowCells } from "../traffic-row";
import { requestsTodayCount, type TrafficLogEntry } from "../traffic-shared";
import { IconCheck, IconAlert } from "../icons";
import { Notice } from "../ui";

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
  if (entry.usage) return entry.usage.totalTokens ?? entry.usage.inputTokens + entry.usage.outputTokens;
  return entry.totalTokens;
}

function tijd(ts: number, locale: string): string {
  return new Date(ts).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Formats a 0..1 ratio as a rounded percentage; em-dash when absent. */
function formatRatio(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 100)}%` : "—";
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
            setLogs(Array.isArray(data) ? data.toSorted((a, b) => b.timestamp - a.timestamp) : []);
            setLogsFailed(false);
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
    return () => { cancelled = true; clearInterval(iv); };
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

  const costUsd = typeof summary?.summary.estimatedCostUsd === "number" && Number.isFinite(summary.summary.estimatedCostUsd)
    ? new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(summary.summary.estimatedCostUsd)
    : "—";
  const coveragePct = formatRatio(summary?.summary.coverageRatio);
  const pct429 = formatRatio(summary?.summary.ratio429);
  const pct502 = formatRatio(summary?.summary.ratio502);

  /* Last 8 traffic entries for the live feed */
  const recentBons = useMemo(() => logs.slice(0, 8), [logs]);

  const proxyOnline = health.data ? true : health.error ? false : null;

  return (
    <div className="page-vanguard">
      <div className="ethereal-bg" />
      
      <div className="vanguard-eyebrow delay-100">{t("dash.eyebrow")}</div>
      <h2 className="vanguard-h2 delay-100" style={{ opacity: 0, animation: 'vanguard-fade-up 0.9s var(--ease-vanguard) forwards' }}>{t("nav.dashboard")}</h2>

      {usageFailed && <Notice tone="err">{t("usage.loadError")}</Notice>}
      {logsFailed && <Notice tone="err">{t("vk.loadFailed")}</Notice>}

      <div className="bento-grid">
        
        {/* Health / System Status (col-span-12) */}
        <div className="vanguard-shell col-span-12 delay-100">
          <div className="vanguard-core" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: '32px', alignItems: 'center' }}>
            <div>
              <div className="vanguard-value-label" style={{ marginTop: 0 }}>{t("dash.proxyStatus")}</div>
              <div className="vanguard-value" style={{ fontSize: '1.5rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
                {proxyOnline === null ? (
                  <span className="spin" />
                ) : proxyOnline ? (
                  <><IconCheck size={18} color="var(--green)" /> {t("proxy.online")}</>
                ) : (
                  <><IconAlert size={18} color="var(--red)" /> {t("proxy.offline")}</>
                )}
              </div>
            </div>
            {health.data && (
              <>
                <div>
                  <div className="vanguard-value-label" style={{ marginTop: 0 }}>{t("dash.version")}</div>
                  <div className="vanguard-value" style={{ fontSize: '1.5rem', fontFamily: 'var(--mono)' }}>{health.data.version}</div>
                </div>
                <div>
                  <div className="vanguard-value-label" style={{ marginTop: 0 }}>{t("dash.uptime")}</div>
                  <div className="vanguard-value" style={{ fontSize: '1.5rem', fontFamily: 'var(--mono)' }}>{formatUptime(health.data.uptime, locale)}</div>
                </div>
                <div>
                  <div className="vanguard-value-label" style={{ marginTop: 0 }}>{t("dash.pid")}</div>
                  <div className="vanguard-value" style={{ fontSize: '1.5rem', fontFamily: 'var(--mono)' }}>{health.data.pid}</div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Primary Usage Stats (col-span-4) */}
        <div className="vanguard-shell col-span-4 delay-200">
          <div className="vanguard-core">
            <div className="vanguard-eyebrow" style={{ width: 'fit-content' }}>{t("dash.volume30d")}</div>
            <div className="vanguard-value">{formatTokens(tokens30d, locale)}</div>
            <div className="vanguard-value-label">{t("vk.tokens30d")}</div>
            
            <div style={{ marginTop: 'auto', paddingTop: '32px' }}>
              <div className="vanguard-value" style={{ fontSize: '2rem' }}>{requests30d.toLocaleString(locale)}</div>
              <div className="vanguard-value-label">{t("vk.requests30d")}</div>
            </div>
          </div>
        </div>

        {/* Financials & Health (col-span-4) */}
        <div className="vanguard-shell col-span-4 delay-200">
          <div className="vanguard-core">
            <div className="vanguard-eyebrow" style={{ width: 'fit-content' }}>{t("dash.economics")}</div>
            <div className="vanguard-value">{costUsd}</div>
            <div className="vanguard-value-label">{t("vk.costUsd")}</div>

            <div style={{ marginTop: 'auto', paddingTop: '32px' }}>
              <div className="vanguard-value" style={{ fontSize: '2rem' }}>{requestsVandaag.toLocaleString(locale)}</div>
              <div className="vanguard-value-label">{t("vk.requestsToday")}</div>
            </div>
          </div>
        </div>

        {/* Reliability (col-span-4) */}
        <div className="vanguard-shell col-span-4 delay-200">
          <div className="vanguard-core">
            <div className="vanguard-eyebrow" style={{ width: 'fit-content' }}>{t("dash.reliability")}</div>
            <div className="vanguard-value">{coveragePct}</div>
            <div className="vanguard-value-label">{t("dash.coverage", { pct: coveragePct })}</div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginTop: 'auto', paddingTop: '32px' }}>
              <div>
                <div className="vanguard-value" style={{ fontSize: '1.5rem' }}>{pct429}</div>
                <div className="vanguard-value-label">HTTP 429</div>
              </div>
              <div>
                <div className="vanguard-value" style={{ fontSize: '1.5rem' }}>{pct502}</div>
                <div className="vanguard-value-label">HTTP 50x</div>
              </div>
            </div>
          </div>
        </div>

        {/* Top providers (col-span-4, row-span-2) */}
        <div className="vanguard-shell col-span-4 row-span-2 delay-300">
          <div className="vanguard-core">
            <h3 style={{ fontSize: '1.25rem', fontWeight: 500, marginBottom: '24px' }}>{t("dash.providers")}</h3>
            {usageProviders.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {usageProviders.map(p => {
                  const name = p.provider;
                  const count = p.requests;
                  const pct = (count / usageProviders[0].requests) * 100;
                  return (
                    <div key={name} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.875rem' }}>
                        <span>{name}</span>
                        <span style={{ color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{count.toLocaleString(locale)}</span>
                      </div>
                      <div style={{ height: '4px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px', overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', borderRadius: '2px' }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p style={{ color: 'var(--muted)' }}>{t("pws.dashboard.noUsage")}</p>
            )}
          </div>
        </div>

        {/* Recent traffic (col-span-8) */}
        <div className="vanguard-shell col-span-8 row-span-2 delay-400">
          <div className="vanguard-core">
            <h3 style={{ fontSize: '1.25rem', fontWeight: 500, marginBottom: '24px' }}>{t("nav.usage")}</h3>
            {recentBons.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {recentBons.map(entry => {
                  const id = entry.requestId ?? `${entry.timestamp}-${entry.provider}-${entry.model}`;
                  const tokens = bonTokens(entry);
                  return (
                    <div key={id} style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: '16px', paddingBottom: '12px', borderBottom: '1px solid var(--border-soft)', fontSize: '0.875rem' }}>
                      <span style={{ color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{tijd(entry.timestamp, locale)}</span>
                      <div>
                        <TrafficRowCells entry={entry} locale={locale} tokens={tokens} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p style={{ color: 'var(--muted)' }}>{t("vk.empty")}</p>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
