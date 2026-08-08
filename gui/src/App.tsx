import { useEffect, useRef, useState } from "react";
import { useKeyedClientResource } from "./client-resource";
import Providers from "./pages/Providers";
import Models from "./pages/Models";
import Combos from "./pages/Combos";
import Subagents from "./pages/Subagents";
import Logs from "./pages/Logs";
import Usage from "./pages/Usage";
import Storage from "./pages/Storage";
import ApiKeys from "./pages/ApiKeys";
import Claude from "./pages/Claude";
import Grok from "./pages/Grok";
import Startup from "./pages/Startup";
import ErrorBoundary from "./components/ErrorBoundary";
import SettingsSheet from "./components/SettingsSheet";
import { IconAlert, IconCheck, IconPower, IconSettings } from "./icons";
import { useT, type TKey } from "./i18n/shared";
import { installApiAuthFetch } from "./api";
import { canonicalHashFor, type View } from "./app-routing";
import { useAppRouteState } from "./use-app-route-state";
import { requestProxyStop } from "./stop-proxy";

installApiAuthFetch();

type Theme = "light" | "dark" | "system";

const API_BASE = import.meta.env.VITE_API_BASE || "";
const THEME_KEY = "ocx-theme";

/** Four views (design-system v2 IA, 2026-08). Leveranciers is home. */
const VIEW_TABS: { view: View; tkey: TKey }[] = [
  { view: "leveranciers", tkey: "nav.providers" },
  { view: "modellen", tkey: "nav.models" },
  { view: "verkeer", tkey: "nav.verkeer" },
  { view: "systeem", tkey: "nav.systeem" },
];

/** Sub-tabs per view; `null` is the view's home target. */
const SUB_TABS: Record<View, { sub: string | null; tkey: TKey }[]> = {
  leveranciers: [
    { sub: null, tkey: "sub.overview" },
    { sub: "claude", tkey: "nav.claude" },
    { sub: "grok", tkey: "nav.grok" },
  ],
  modellen: [
    { sub: null, tkey: "nav.models" },
    { sub: "combos", tkey: "nav.combos" },
    { sub: "subagents", tkey: "nav.subagents" },
  ],
  verkeer: [
    { sub: null, tkey: "nav.usage" },
    { sub: "logs", tkey: "sub.logs" },
    { sub: "debug", tkey: "sub.debug" },
  ],
  systeem: [
    { sub: null, tkey: "sub.status" },
    { sub: "storage", tkey: "nav.storage" },
    { sub: "api", tkey: "nav.api" },
  ],
};

function readStoredTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    // Private/blocked storage must not prevent the dashboard from rendering.
    return "system";
  }
}

function readRuntimeVersion(data: unknown): string | null {
  if (!data || typeof data !== "object" || !("version" in data)) return null;
  const version = (data as { version?: unknown }).version;
  return typeof version === "string" && version.length > 0 ? version : null;
}

export default function App() {
  const { route, navigateTo } = useAppRouteState();
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const t = useT();
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const el = document.documentElement;
    if (theme === "system") el.removeAttribute("data-theme");
    else el.setAttribute("data-theme", theme);
    try {
      if (theme === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Theme persistence is optional; blocked storage must not break rendering.
    }
  }, [theme]);

  const healthPoll = useKeyedClientResource(
    `app-healthz:${API_BASE}`,
    [],
    async (signal) => {
      const res = await fetch(`${API_BASE}/healthz`, { signal });
      if (!res.ok) throw new Error(String(res.status));
      return { version: readRuntimeVersion(await res.json()) };
    },
    { pollMs: 30_000 },
  );

  const displayedVersion: string = healthPoll.data?.version ?? __APP_VERSION__;
  // null = first poll still in flight: no stamp until the first verdict.
  const proxyOnline: boolean | null = healthPoll.error ? false : healthPoll.data ? true : null;

  const activeTkey =
    SUB_TABS[route.view].find(s => s.sub === route.sub)?.tkey ?? "nav.providers";

  const brand = (
    <div className="brand">
      <span className="brand-logo" role="img" aria-label={t("app.logoAria")} />
      <span className="name">opencodex</span>
      <span className="ver">v{displayedVersion}</span>
    </div>
  );

  return (
    <div className="app">
      <header className="topbar">
        {brand}
        <div className="topbar-right">
          {proxyOnline !== null && (
            <span className={`stamp${proxyOnline ? " stamp-ok" : " stamp-err"}`} role="status">
              {proxyOnline ? <IconCheck size={13} aria-hidden /> : <IconAlert size={13} aria-hidden />}
              {t(proxyOnline ? "proxy.online" : "proxy.offline")}
            </span>
          )}
          <button type="button" className="gbtn" onClick={() => setSettingsOpen(true)}
            aria-label={t("settings.open")} title={t("settings.open")}>
            <IconSettings />
          </button>
        </div>
      </header>

      {proxyOnline === false && (
        <div className="offline-banner" role="alert">
          <IconAlert size={15} aria-hidden />
          <span>{t("offline.banner")}</span>
          <button type="button" className="link-btn" onClick={() => navigateTo({ view: "systeem", sub: null })}>
            {t("offline.toSystem")}
          </button>
        </div>
      )}

      <nav className="view-tabs" aria-label={t("nav.views")}>
        {VIEW_TABS.map(({ view, tkey }) => (
          <button key={view} type="button"
            className={`view-tab${route.view === view ? " active" : ""}`}
            onClick={() => navigateTo({ view, sub: null })}
            aria-current={route.view === view ? "page" : undefined}>
            {t(tkey)}
          </button>
        ))}
      </nav>

      <main className="main">
        <div className={`main-inner${route.view === "modellen" && route.sub === "combos" ? " main-inner--combos" : ""}`}>
          <nav className="sub-tabs">
            {SUB_TABS[route.view].map(({ sub, tkey }) => (
              <button key={sub ?? "home"} type="button"
                className={`sub-tab${route.sub === sub ? " active" : ""}`}
                onClick={() => navigateTo({ view: route.view, sub })}
                aria-current={route.sub === sub ? "page" : undefined}>
                {t(tkey)}
              </button>
            ))}
          </nav>
          <div className="page-reveal" key={canonicalHashFor(route)}>
          <ErrorBoundary
            pageName={t(activeTkey)}
            title={t("errorBoundary.title")}
            message={t("errorBoundary.message")}
            detailsLabel={t("errorBoundary.details")}
            reloadLabel={t("errorBoundary.reload")}
          >
            {route.view === "leveranciers" && route.sub === null && <Providers apiBase={API_BASE} />}
            {route.view === "leveranciers" && route.sub === "claude" && <Claude apiBase={API_BASE} />}
            {route.view === "leveranciers" && route.sub === "grok" && <Grok apiBase={API_BASE} />}
            {route.view === "modellen" && route.sub === null && <Models apiBase={API_BASE} />}
            {route.view === "modellen" && route.sub === "combos" && <Combos key={API_BASE} apiBase={API_BASE} />}
            {route.view === "modellen" && route.sub === "subagents" && <Subagents key={API_BASE} apiBase={API_BASE} />}
            {route.view === "verkeer" && route.sub === null && <Usage apiBase={API_BASE} />}
            {route.view === "verkeer" && (route.sub === "logs" || route.sub === "debug") && <Logs apiBase={API_BASE} />}
            {route.view === "systeem" && route.sub === null && <Startup apiBase={API_BASE} />}
            {route.view === "systeem" && route.sub === "storage" && <Storage apiBase={API_BASE} />}
            {route.view === "systeem" && route.sub === "api" && <ApiKeys apiBase={API_BASE} />}
          </ErrorBoundary>
          </div>
          {route.view === "systeem" && route.sub === null && <DangerZone />}
        </div>
      </main>

      {settingsOpen && (
        <SettingsSheet theme={theme} onTheme={setTheme} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}

/** Danger zone (Systeem home): destructive actions live here — named, separated,
    and behind an explicit confirmation. Never in navigation. */
function DangerZone() {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!confirming) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !stopping) setConfirming(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming, stopping]);

  const handleStop = async () => {
    setStopping(true);
    const outcome = await requestProxyStop(API_BASE, {
      formatFailure: status => t("dash.stopFailed", { status: String(status) }),
    });
    // Refusals and restore failures return normally instead of dropping the connection.
    // In both cases the proxy did not reach a clean-stop result, so surface the server's
    // remediation instead of leaving "stopping…" stuck forever.
    if (!outcome.accepted) {
      setStopping(false);
      setConfirming(false);
      alert(outcome.message);
    }
  };

  return (
    <section className="danger-zone" aria-labelledby="danger-zone-title">
      <h3 id="danger-zone-title" className="danger-title">{t("danger.title")}</h3>
      <div className="danger-row">
        <div className="danger-copy">
          <div className="danger-action">{t("danger.stopAction")}</div>
          <div className="muted">{t("danger.stopBody")}</div>
        </div>
        <button type="button" className="btn btn-danger" onClick={() => setConfirming(true)}>
          <IconPower size={13} aria-hidden /> {t("dash.stop")}
        </button>
      </div>

      {confirming && (
        <div className="modal-overlay" role="alertdialog" aria-modal="true"
          aria-labelledby="stop-proxy-title" aria-describedby="stop-proxy-desc"
          onClick={e => { if (e.target === e.currentTarget && !stopping) setConfirming(false); }}>
          <div className="modal-card modal-card--narrow">
            <div className="modal-head">
              <h3 id="stop-proxy-title">{t("danger.stopTitle")}</h3>
            </div>
            <p id="stop-proxy-desc" className="modal-desc">{t("danger.stopBody")}</p>
            <div className="modal-actions">
              <button ref={cancelRef} type="button" className="btn" onClick={() => setConfirming(false)} disabled={stopping}>
                {t("common.cancel")}
              </button>
              <button type="button" className="btn btn-danger" onClick={() => void handleStop()} disabled={stopping}>
                <IconPower size={13} aria-hidden /> {stopping ? t("dash.stopping") : t("danger.stopAction")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
