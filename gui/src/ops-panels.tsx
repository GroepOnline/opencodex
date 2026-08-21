/**
 * Ops panels for the Verkeer page (Fase D quality round).
 *
 * - ResponseCachePanel: live KV response-cache observability (stats + config echo) with an
 *   operator clear action. Data: GET /api/response-cache, action: POST /api/response-cache/clear.
 * - KeyPoolHealthPanel: per-provider routing health — pool size, cooling keys, provider cap
 *   countdowns. Data: GET /api/availability.
 *
 * Both ride the management gate server-side; the GUI only renders scalar payloads. Polling is
 * deliberately slow (15s) to stay well under the CF edge rate limit that bit /api/* before.
 */
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "./i18n/shared";
import { formatCountdown } from "./format-countdown";

/** Slow poll — CF edge used to 1015 at 100/min on /api/*; keep headroom for other tabs. */
const OPS_POLL_MS = 15_000;

interface CacheStats {
  hits: number;
  misses: number;
  stores: number;
  evictions: number;
  expired: number;
  tooLarge: number;
}

interface ResponseCacheView {
  enabled: boolean;
  stats?: CacheStats;
  size?: number;
  ttlMs?: number;
  maxEntries?: number;
  maxBodyBytes?: number;
  persist?: boolean;
}

export interface AvailabilityProvider {
  name: string;
  keyPoolCount: number;
  hopProvider?: string;
  hopModel?: string;
  coolingKeyCount: number;
  capUntil?: number;
  capDisabled?: boolean;
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

/**
 * Live response-cache panel: hit-rate strip + counters + operator clear.
 *
 * @param apiBase - The base URL for API requests.
 * @param onCleared - Optional callback fired after a successful clear (lets parents refresh).
 */
export function ResponseCachePanel({ apiBase, onCleared }: { apiBase: string; onCleared?: () => void }) {
  const { locale, t } = useI18n();
  const [view, setView] = useState<ResponseCacheView | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${apiBase}/api/response-cache`);
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json() as ResponseCacheView;
        if (!cancelled) {
          setView(data);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    void load();
    const iv = setInterval(() => void load(), OPS_POLL_MS);
    return () => { cancelled = true; clearInterval(iv); };
  }, [apiBase]);

  const clear = async () => {
    setBusy(true);
    try {
      const cleared = await fetch(`${apiBase}/api/response-cache/clear`, { method: "POST" });
      if (!cleared.ok) throw new Error(String(cleared.status));
      const res = await fetch(`${apiBase}/api/response-cache`);
      if (!res.ok) throw new Error(String(res.status));
      setView(await res.json() as ResponseCacheView);
      onCleared?.();
    } catch { /* keep last-good */ } finally {
      setBusy(false);
    }
  };

  if (failed && !view) {
    return <p className="text-caption" style={{ color: "var(--wijn)" }}>{t("ops.cacheFailed")}</p>;
  }
  if (!view || !view.enabled) {
    return (
      <p className="text-caption" style={{ color: "var(--gietijzer-60)" }}>
        {t("ops.cacheOff")}
      </p>
    );
  }

  const s = view.stats ?? { hits: 0, misses: 0, stores: 0, evictions: 0, expired: 0, tooLarge: 0 };
  const lookups = s.hits + s.misses;

  return (
    <div>
      <div className="stat-strip" role="group" aria-label={t("ops.cacheAria")}>
        <div className="stat-strip-item">
          <span className="stat-strip-waarde">{pct(s.hits, lookups)}</span>
          <span className="stat-strip-label">{t("ops.cacheHitRate")}</span>
        </div>
        <div className="stat-strip-item">
          <span className="stat-strip-waarde">{(view.size ?? 0).toLocaleString(locale)}</span>
          <span className="stat-strip-label">{t("ops.cacheEntries", { n: String(view.maxEntries ?? 0) })}</span>
        </div>
        <div className="stat-strip-item">
          <span className="stat-strip-waarde">{s.hits.toLocaleString(locale)}</span>
          <span className="stat-strip-label">{t("ops.cacheHits")}</span>
        </div>
        <div className="stat-strip-item">
          <span className="stat-strip-waarde">{s.misses.toLocaleString(locale)}</span>
          <span className="stat-strip-label">{t("ops.cacheMisses")}</span>
        </div>
        <div className="stat-strip-item">
          <span className="stat-strip-waarde">{s.evictions.toLocaleString(locale)}</span>
          <span className="stat-strip-label">{t("ops.cacheEvictions")}</span>
        </div>
        <div className="stat-strip-item">
          <span className="stat-strip-waarde">{s.expired.toLocaleString(locale)}</span>
          <span className="stat-strip-label">{t("ops.cacheExpired")}</span>
        </div>
        <div className="stat-strip-item">
          <span className="stat-strip-waarde">{s.tooLarge.toLocaleString(locale)}</span>
          <span className="stat-strip-label">{t("ops.cacheTooLarge")}</span>
        </div>
      </div>
      <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
        <span className="text-caption" style={{ color: "var(--gietijzer-60)" }}>
          {t("ops.cacheConfig", {
            ttl: String(Math.round((view.ttlMs ?? 0) / 1000)),
            max: String(view.maxEntries ?? 0),
            cap: String(Math.round((view.maxBodyBytes ?? 0) / 1024)),
            persist: view.persist ? t("ops.persistOn") : t("ops.persistOff"),
          })}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          style={{ marginLeft: "auto" }}
          onClick={() => void clear()}
          disabled={busy}
        >
          {busy ? t("ops.clearing") : t("ops.cacheClear")}
        </button>
      </div>
    </div>
  );
}

/**
 * Per-provider key-pool health: pool size, cooling keys, provider-cap countdown.
 *
 * @param apiBase - The base URL for API requests.
 */
export function KeyPoolHealthPanel({ apiBase }: { apiBase: string }) {
  const { locale, t } = useI18n();
  const [providers, setProviders] = useState<AvailabilityProvider[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Ticking clock so countdowns stay live between polls without extra fetches.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${apiBase}/api/availability`);
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json() as { providers: AvailabilityProvider[] };
        if (!cancelled) {
          setProviders(Array.isArray(data.providers) ? data.providers : []);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    void load();
    const iv = setInterval(() => void load(), OPS_POLL_MS);
    return () => { cancelled = true; clearInterval(iv); };
  }, [apiBase]);

  // 30s tick: cheap re-render for live countdowns (poll cadence stays at 15s).
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(iv);
  }, []);

  const rows = useMemo(() => {
    const list = providers ?? [];
    return list.toSorted((a, b) => {
      // Troubled providers first: caps, then cooling keys, then name.
      const aCap = a.capUntil !== undefined && a.capUntil > now ? 1 : 0;
      const bCap = b.capUntil !== undefined && b.capUntil > now ? 1 : 0;
      if (aCap !== bCap) return bCap - aCap;
      if (a.coolingKeyCount !== b.coolingKeyCount) return b.coolingKeyCount - a.coolingKeyCount;
      return a.name.localeCompare(b.name);
    });
  }, [providers, now]);

  if (failed && !providers) {
    return <p className="text-caption" style={{ color: "var(--wijn)" }}>{t("ops.poolFailed")}</p>;
  }
  if (!providers) return null;

  return (
    <table className="depas-tabel" style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th style={{ textAlign: "left" }}>{t("ops.poolColProvider")}</th>
          <th style={{ textAlign: "right" }}>{t("ops.poolColKeys")}</th>
          <th style={{ textAlign: "right" }}>{t("ops.poolColCooling")}</th>
          <th style={{ textAlign: "right" }}>{t("ops.poolColCap")}</th>
          <th style={{ textAlign: "left" }}>{t("ops.poolColHop")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(p => {
          const capped = p.capUntil !== undefined && p.capUntil > now;
          const capIn = capped ? formatCountdown((p.capUntil as number) - now) : null;
          return (
            <tr key={p.name} style={capped ? { color: "var(--wijn)" } : undefined}>
              <td style={{ fontFamily: "var(--font-code)" }}>{p.name}</td>
              <td style={{ textAlign: "right" }}>{p.keyPoolCount.toLocaleString(locale)}</td>
              <td style={{ textAlign: "right" }}>
                {p.coolingKeyCount > 0 ? p.coolingKeyCount.toLocaleString(locale) : "—"}
              </td>
              <td style={{ textAlign: "right" }}>
                {capped
                  ? p.capDisabled
                    ? t("ops.poolCapDisabled")
                    : capIn
                  : "—"}
              </td>
              <td style={{ fontFamily: "var(--font-code)", color: "var(--gietijzer-60)" }}>
                {p.hopProvider ? `${p.hopProvider}/${p.hopModel ?? ""}` : "—"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
