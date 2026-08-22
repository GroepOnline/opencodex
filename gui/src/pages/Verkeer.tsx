import { useEffect, useMemo, useRef, useState } from "react";
import Usage from "./Usage";
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
  summary: { requests: number; totalTokens: number };
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

  return (
    <>
      <div className="page-head">
        <h2>{t("shell.navTraffic")}</h2>
      </div>
      <p className="page-sub">{t("vk.subtitle")}</p>

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
      </div>

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
        <p className="text-caption" style={{ color: "var(--red)" }} role="status">
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
            <div key={id} className="traffic-entry">
              <button
                type="button"
                className="traffic-entry-head traffic-entry-head--grid"
                style={{ width: "100%", background: "transparent", border: "none", padding: 0, font: "inherit", color: "inherit", cursor: "pointer", textAlign: "left" }}
                onClick={() => setOpenBon(current => current === id ? null : id)}
                aria-expanded={isOpen}
              >
                <span className="traffic-col traffic-col--time traffic-time">{tijd(entry.timestamp, locale)}</span>
                <TrafficRowCells entry={entry} locale={locale} tokens={tokens} />
              </button>
              {isOpen && (
                <div className="traffic-detail">
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
