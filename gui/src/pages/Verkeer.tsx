import { useEffect, useMemo, useRef, useState } from "react";
import Usage from "./Usage";
import { useI18n } from "../i18n/shared";
import { formatTokens } from "../format-tokens";
import { statusCodeInfo } from "../status-codes";
import { modelLabel } from "../model-display";

interface UsageSummary {
  summary: { requests: number; totalTokens: number };
  days: Array<{ date: string; requests: number; totalTokens?: number }>;
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

const TAIL_INTERVAL_MS = 5000;

function bonTokens(entry: BonEntry): number | undefined {
  if (entry.usage) return entry.usage.totalTokens ?? entry.usage.inputTokens + entry.usage.outputTokens;
  return entry.totalTokens;
}

function bonStempel(entry: BonEntry): { label: string; cls: string } {
  if (entry.status >= 200 && entry.status < 300) return { label: "Klaar", cls: "stempel--klaar" };
  if (entry.status === 0) return { label: "Fout", cls: "stempel--fout" };
  if (entry.status >= 400) return { label: "Fout", cls: "stempel--fout" };
  return { label: "Bezig", cls: "" };
}

function tijd(ts: number, locale: string): string {
  return new Date(ts).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function vandaagKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Verkeer: stat-strip + de bonnenrail met recente requests, met de volledige analyse eronder. */
export default function Verkeer({ apiBase }: { apiBase: string }) {
  const { locale } = useI18n();
  const [summary30d, setSummary30d] = useState<UsageSummary | null>(null);
  const [logs, setLogs] = useState<BonEntry[]>([]);
  const [logsFailed, setLogsFailed] = useState(false);
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [openBon, setOpenBon] = useState<string | null>(null);
  const [analyseOpen, setAnalyseOpen] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

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
        const data = await res.json() as BonEntry[];
        if (!cancelled) {
          setLogs(Array.isArray(data) ? [...data].sort((a, b) => b.timestamp - a.timestamp) : []);
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

  const providers = useMemo(() => [...new Set(logs.map(l => l.provider))].sort(), [logs]);
  const zichtbaar = useMemo(
    () => (providerFilter ? logs.filter(l => l.provider === providerFilter) : logs).slice(0, 60),
    [logs, providerFilter],
  );

  const requestsVandaag = useMemo(() => {
    const key = vandaagKey();
    return summary30d?.days.find(d => d.date === key)?.requests ?? 0;
  }, [summary30d]);

  const requests30d = summary30d?.summary.requests ?? 0;
  const tokens30d = summary30d?.summary.totalTokens ?? 0;

  return (
    <>
      <div className="depas-viewkop">
        <h2>Verkeer</h2>
      </div>
      <p className="depas-viewsub">Wat er door de proxy gaat: elke request is een bon.</p>

      <div className="stat-strip" role="group" aria-label="Verkeerscijfers">
        <div className="stat-strip-item">
          <span className="stat-strip-waarde">{formatTokens(tokens30d, locale)}</span>
          <span className="stat-strip-label">tokens (30d)</span>
        </div>
        <div className="stat-strip-item">
          <span className="stat-strip-waarde">{requestsVandaag.toLocaleString(locale)}</span>
          <span className="stat-strip-label">requests vandaag</span>
        </div>
        <div className="stat-strip-item">
          <span className="stat-strip-waarde">{requests30d.toLocaleString(locale)}</span>
          <span className="stat-strip-label">requests (30d)</span>
        </div>
      </div>

      <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <div className="usage-segmented" role="group" aria-label="Filter op provider">
          <button
            type="button"
            className={`usage-segmented-btn${providerFilter === null ? " active" : ""}`}
            onClick={() => setProviderFilter(null)}
          >
            Alles
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
          {paused ? "Volg live" : "Pauzeer"}
        </button>
      </div>

      {logsFailed && (
        <p className="text-caption" style={{ color: "var(--wijn)" }} role="status">
          Verkeer laden lukt niet. Laatste bekende bonnen blijven staan.
        </p>
      )}

      <div className="rail" aria-live="polite" onFocus={() => setPaused(true)}>
        {zichtbaar.length === 0 ? (
          <p className="muted" style={{ fontFamily: "var(--font-code)", fontSize: "0.875rem" }}>
            Nog geen verkeer vandaag.
          </p>
        ) : zichtbaar.map(entry => {
          const id = entry.requestId ?? `${entry.timestamp}-${entry.provider}-${entry.model}`;
          const stempel = bonStempel(entry);
          const tokens = bonTokens(entry);
          const isOpen = openBon === id;
          const statusInfo = statusCodeInfo(entry.status, locale);
          return (
            <div key={id} className="bon">
              <button
                type="button"
                className="bon-kop"
                style={{ width: "100%", background: "transparent", border: "none", padding: 0, font: "inherit", color: "inherit", cursor: "pointer", textAlign: "left" }}
                onClick={() => setOpenBon(current => current === id ? null : id)}
                aria-expanded={isOpen}
              >
                <span className="bon-tijd">{tijd(entry.timestamp, locale)}</span>
                <span className="bon-titel">{modelLabel(entry.model)}</span>
                <span className="bon-meta">{entry.provider}</span>
                {tokens !== undefined && <span className="bon-meta">{formatTokens(tokens, locale)} tok</span>}
                <span className="bon-meta">{(entry.durationMs / 1000).toFixed(1)}s</span>
                <span className={`stempel ${stempel.cls}`}>{stempel.label}</span>
              </button>
              {isOpen && (
                <div className="bon-detail">
                  <div>status {entry.status}{statusInfo ? ` · ${statusInfo.label}` : ""}</div>
                  {entry.errorCode && <div>fout: {entry.errorCode}</div>}
                  {entry.upstreamError && <div>upstream: {entry.upstreamError}</div>}
                  {entry.usage && (
                    <div>in {entry.usage.inputTokens} · uit {entry.usage.outputTokens}</div>
                  )}
                  {entry.requestId && <div>id {entry.requestId}</div>}
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
          {analyseOpen ? "Verberg analyse" : "Volledige analyse"}
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
