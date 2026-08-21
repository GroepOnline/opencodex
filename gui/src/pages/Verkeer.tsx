import { useEffect, useMemo, useRef, useState } from "react";
import Usage from "./Usage";
import { KeyPoolHealthPanel, ResponseCachePanel } from "../ops-panels";
import { useI18n } from "../i18n/shared";
import { formatTokens } from "../format-tokens";
import { TrafficColumnHead, TrafficRowCells } from "../traffic-row";
import {
  requestsTodayCount,
  trafficPrincipalLabel,
  trafficProviderModelLabel,
  type TrafficLogEntry,
} from "../traffic-shared";

interface UsageSummary {
  summary: {
    requests: number;
    totalTokens: number;
    estimatedCostUsd?: number;
    cacheReadRatio?: number;
    p95LatencyMs?: number;
    ratio429?: number;
    ratio502?: number;
  };
  providers?: Array<{
    provider: string;
    requests: number;
    totalTokens: number;
    estimatedCostUsd?: number;
    cacheReadRatio?: number;
  }>;
  models?: Array<{
    provider: string;
    model: string;
    requests: number;
    totalTokens: number;
    inputTokens?: number;
    outputTokens?: number;
    shareRatio?: number;
    estimatedCostUsd?: number;
  }>;
  days: Array<{ date: string; requests: number; totalTokens?: number }>;
}

/** Soft poll — CF edge used to 1015 at 100/min on /api/*; keep headroom for other tabs. */
const TAIL_INTERVAL_MS = 12_000;

/**
 * Determines the total token count for a traffic log entry.
 *
 * @param entry - The traffic log entry to inspect
 * @returns The total token count, or `undefined` when unavailable
 */
function bonTokens(entry: TrafficLogEntry): number | undefined {
  if (entry.usage) return entry.usage.totalTokens ?? entry.usage.inputTokens + entry.usage.outputTokens;
  return entry.totalTokens;
}

/**
 * Formats a timestamp as a localized time with hours, minutes, and seconds.
 *
 * @param ts - The timestamp in milliseconds
 * @param locale - The locale used for formatting
 * @returns The localized time string
 */
function tijd(ts: number, locale: string): string {
  return new Date(ts).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Displays traffic statistics, recent requests, provider filters, and optional usage analysis.
 *
 * @param apiBase - The base URL for API requests.
 * @param target - The navigation target used to open usage analysis.
 */
export default function Verkeer({ apiBase, target }: { apiBase: string; target?: string }) {
  const { locale, t } = useI18n();
  const [summary30d, setSummary30d] = useState<UsageSummary | null>(null);
  const [logs, setLogs] = useState<TrafficLogEntry[]>([]);
  const [logsFailed, setLogsFailed] = useState(false);
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [openBon, setOpenBon] = useState<string | null>(null);
  const [analyseOpen, setAnalyseOpen] = useState(target === "usage");
  const [opsOpen, setOpsOpen] = useState(false);
  const pausedRef = useRef(paused);
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  const [seenTarget, setSeenTarget] = useState(target);
  if (target !== seenTarget) {
    setSeenTarget(target);
    if (target === "usage") setAnalyseOpen(true);
  }

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${apiBase}/api/usage?range=30d`);
        if (!res.ok) return;
        const data = await res.json() as UsageSummary;
        if (!cancelled) setSummary30d(data);
      } catch { /* keep last-good */ }
    };
    void load();
    const iv = setInterval(() => void load(), 60_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [apiBase]);

  useEffect(() => {
    let cancelled = false;
    const tail = async () => {
      if (pausedRef.current) return;
      try {
        const res = await fetch(`${apiBase}/api/logs`);
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json() as TrafficLogEntry[];
        if (!cancelled) {
          setLogs(Array.isArray(data) ? data.toSorted((a, b) => b.timestamp - a.timestamp) : []);
          setLogsFailed(false);
        }
      } catch {
        if (!cancelled) setLogsFailed(true);
      }
    };
    void tail();
    const iv = setInterval(() => void tail(), TAIL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(iv); };
  }, [apiBase]);

  const providers = useMemo(() => {
    const names = new Set<string>();
    for (const entry of logs) {
      const principal = trafficPrincipalLabel(entry, t);
      if (principal !== t("vk.unknown")) names.add(principal);
      const providerModel = trafficProviderModelLabel(entry);
      if (providerModel?.includes("/")) names.add(providerModel.split("/")[0]!);
    }
    return [...names].sort();
  }, [logs, t]);

  const zichtbaar = useMemo(() => {
    const rows = providerFilter
      ? logs.filter(entry => {
        const principal = trafficPrincipalLabel(entry, t);
        const providerModel = trafficProviderModelLabel(entry) ?? "";
        return principal === providerFilter
          || entry.provider === providerFilter
          || providerModel.startsWith(`${providerFilter}/`);
      })
      : logs;
    return rows.slice(0, 60);
  }, [logs, providerFilter, t]);

  const requestsVandaag = useMemo(
    () => requestsTodayCount(logs, summary30d?.days),
    [logs, summary30d],
  );

  const requests30d = summary30d?.summary.requests ?? 0;
  const tokens30d = summary30d?.summary.totalTokens ?? 0;

  /** Per-model breakdown (top 12 by requests, 30d from /api/usage models[]). */
  const topModellen = useMemo(() => {
    const ms = summary30d?.models ?? [];
    return ms.toSorted((a, b) => b.requests - a.requests).slice(0, 12);
  }, [summary30d]);

  return (
    <>
      <div className="depas-viewkop">
        <h2>{t("shell.navTraffic")}</h2>
      </div>
      <p className="depas-viewsub">{t("vk.subtitle")}</p>

      <div className="stat-strip" role="group" aria-label={t("vk.statsAria")}>
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
        <div className="stat-strip-item">
          <span className="stat-strip-waarde">
            {typeof summary30d?.summary.cacheReadRatio === "number"
              ? `${Math.round(summary30d.summary.cacheReadRatio * 100)}%`
              : "—"}
          </span>
          <span className="stat-strip-label">{t("vk.cacheHit")}</span>
        </div>
        <div className="stat-strip-item">
          <span className="stat-strip-waarde">
            {typeof summary30d?.summary.estimatedCostUsd === "number"
              ? `€${(summary30d.summary.estimatedCostUsd * 0.92).toFixed(2)}`
              : "—"}
          </span>
          <span className="stat-strip-label">{t("vk.costUsd")}</span>
        </div>
        <div className="stat-strip-item">
          <span className="stat-strip-waarde">
            {typeof summary30d?.summary.p95LatencyMs === "number" && summary30d.summary.p95LatencyMs > 0
              ? `${(summary30d.summary.p95LatencyMs / 1000).toFixed(1)}${t("vk.p95Unit")}`
              : "—"}
          </span>
          <span className="stat-strip-label">{t("vk.p95")}</span>
        </div>
        <div className="stat-strip-item">
          <span className="stat-strip-waarde">
            {typeof summary30d?.summary.ratio429 === "number"
              ? `${Math.round(summary30d.summary.ratio429 * 100)}%`
              : "—"}
          </span>
          <span className="stat-strip-label">{t("vk.ratio429")}</span>
        </div>
      </div>

      {summary30d?.providers && summary30d.providers.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3 className="depas-viewsub" style={{ marginBottom: 8 }}>{t("vk.providerTableHead")}</h3>
          <table className="depas-tabel" style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>{t("vk.providerColProvider")}</th>
                <th style={{ textAlign: "right" }}>{t("vk.providerColRequests")}</th>
                <th style={{ textAlign: "right" }}>{t("vk.providerColTokens")}</th>
                <th style={{ textAlign: "right" }}>{t("vk.providerColCost")}</th>
                <th style={{ textAlign: "right" }}>{t("vk.providerColCache")}</th>
              </tr>
            </thead>
            <tbody>
              {summary30d.providers
                .slice()
                .sort((a, b) => b.requests - a.requests)
                .map(p => (
                  <tr key={p.provider}>
                    <td style={{ fontFamily: "var(--font-code)" }}>{p.provider}</td>
                    <td style={{ textAlign: "right" }}>{p.requests.toLocaleString(locale)}</td>
                    <td style={{ textAlign: "right" }}>{formatTokens(p.totalTokens, locale)}</td>
                    <td style={{ textAlign: "right" }}>
                      {typeof p.estimatedCostUsd === "number" ? `€${(p.estimatedCostUsd * 0.92).toFixed(2)}` : "—"}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {typeof p.cacheReadRatio === "number" ? `${Math.round(p.cacheReadRatio * 100)}%` : "—"}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {topModellen.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3 className="depas-viewsub" style={{ marginBottom: 8 }}>{t("vk.modelTableHead")}</h3>
          <table className="depas-tabel" style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>{t("vk.modelColModel")}</th>
                <th style={{ textAlign: "right" }}>{t("vk.modelColRequests")}</th>
                <th style={{ textAlign: "right" }}>{t("vk.modelColTokens")}</th>
                <th style={{ textAlign: "right" }}>{t("vk.modelColShare")}</th>
                <th style={{ textAlign: "right" }}>{t("vk.modelColCost")}</th>
              </tr>
            </thead>
            <tbody>
              {topModellen.map(m => (
                <tr key={`${m.provider}/${m.model}`}>
                  <td style={{ fontFamily: "var(--font-code)" }}>
                    {m.model}
                    {m.provider && (
                      <span style={{ color: "var(--gietijzer-60)" }}> · {m.provider}</span>
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>{m.requests.toLocaleString(locale)}</td>
                  <td style={{ textAlign: "right" }}>{formatTokens(m.totalTokens, locale)}</td>
                  <td style={{ textAlign: "right" }}>
                    {typeof m.shareRatio === "number"
                      ? `${Math.round(m.shareRatio * 100)}%`
                      : "—"}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {typeof m.estimatedCostUsd === "number" ? `€${(m.estimatedCostUsd * 0.92).toFixed(2)}` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <div className="usage-segmented" role="group" aria-label={t("vk.filterAria")}>
          <button
            type="button"
            className={`usage-segmented-btn${providerFilter === null ? " active" : ""}`}
            onClick={() => setProviderFilter(null)}
          >
            {t("vk.all")}
          </button>
          {providers.map(p => (
            <button
              key={p}
              type="button"
              className={`usage-segmented-btn${providerFilter === p ? " active" : ""}`}
              onClick={() => setProviderFilter(current => current === p ? null : p)}
            >
              {p}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          style={{ marginLeft: "auto" }}
          onClick={() => setPaused(p => !p)}
          aria-pressed={paused}
        >
          {paused ? t("vk.follow") : t("vk.pause")}
        </button>
      </div>

      {logsFailed && (
        <p className="text-caption" style={{ color: "var(--wijn)" }} role="status">
          {t("vk.loadFailed")}
        </p>
      )}

      <TrafficColumnHead />

      <div className="rail" aria-live="polite" onFocus={() => setPaused(true)}>
        {zichtbaar.length === 0 ? (
          <p className="muted" style={{ fontFamily: "var(--font-code)", fontSize: "0.875rem" }}>
            {t("vk.empty")}
          </p>
        ) : zichtbaar.map(entry => {
          const id = entry.requestId ?? `${entry.timestamp}-${entry.provider}-${entry.model}`;
          const tokens = bonTokens(entry);
          const isOpen = openBon === id;
          return (
            <div key={id} className="bon">
              <button
                type="button"
                className="bon-kop bon-kop--grid"
                style={{ width: "100%", background: "transparent", border: "none", padding: 0, font: "inherit", color: "inherit", cursor: "pointer", textAlign: "left" }}
                onClick={() => setOpenBon(current => current === id ? null : id)}
                aria-expanded={isOpen}
              >
                <span className="bon-col bon-col--time bon-tijd">{tijd(entry.timestamp, locale)}</span>
                <TrafficRowCells entry={entry} locale={locale} tokens={tokens} />
              </button>
              {isOpen && (
                <div className="bon-detail">
                  <div>{t("vk.detailStatus", { status: entry.status })}</div>
                  {entry.errorCode && <div>{t("vk.detailError", { code: entry.errorCode })}</div>}
                  {entry.upstreamError && <div>{t("vk.detailUpstream", { error: entry.upstreamError })}</div>}
                  {entry.usage && (
                    <div>{t("vk.detailInOut", { in: entry.usage.inputTokens, out: entry.usage.outputTokens })}</div>
                  )}
                  {entry.requestId && <div>{t("vk.detailId", { id: entry.requestId })}</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 48 }}>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setOpsOpen(open => !open)}
          aria-expanded={opsOpen}
        >
          {opsOpen ? t("vk.hideOps") : t("vk.showOps")}
        </button>
        {opsOpen && (
          <div style={{ marginTop: 16, display: "grid", gap: 32 }}>
            <section aria-label={t("ops.cacheAria")}>
              <h3 className="depas-viewsub" style={{ marginBottom: 8 }}>{t("ops.cacheHead")}</h3>
              <ResponseCachePanel apiBase={apiBase} />
            </section>
            <section aria-label={t("ops.poolHead")}>
              <h3 className="depas-viewsub" style={{ marginBottom: 8 }}>{t("ops.poolHead")}</h3>
              <KeyPoolHealthPanel apiBase={apiBase} />
            </section>
          </div>
        )}
      </div>

      <div style={{ marginTop: 48 }}>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setAnalyseOpen(open => !open)}
          aria-expanded={analyseOpen}
        >
          {analyseOpen ? t("vk.hideAnalysis") : t("vk.showAnalysis")}
        </button>
        {analyseOpen && (
          <div style={{ marginTop: 16 }}>
            <Usage apiBase={apiBase} />
          </div>
        )}
      </div>
    </>
  );
}
