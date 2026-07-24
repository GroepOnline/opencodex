import { useEffect, useState } from "react";
import Providers from "./pages/Providers";
import Modellen from "./pages/Modellen";
import Verkeer from "./pages/Verkeer";
import Systeem from "./pages/Systeem";
import InstellingenSheet from "./pages/Instellingen";
import { IconSettings } from "./icons";
import { installApiAuthFetch } from "./api";
import { applyTheme, readTheme } from "./theme";
import { useT, type TKey } from "./i18n/shared";
import { canonicalHash, parseHash, type Page, type Route } from "./route";

installApiAuthFetch();

const readRouteFromHash = (): Route => parseHash(location.hash);

const API_BASE = import.meta.env.VITE_API_BASE || "";

const NAV: { id: Page; labelKey: TKey }[] = [
  { id: "leveranciers", labelKey: "nav.providers" },
  { id: "modellen", labelKey: "nav.models" },
  { id: "verkeer", labelKey: "shell.navTraffic" },
  { id: "systeem", labelKey: "shell.navSystem" },
];

interface HealthData { status: string; version: string; uptime: number }

export default function App() {
  const t = useT();
  const [route, setRoute] = useState<Route>(readRouteFromHash);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [healthFailed, setHealthFailed] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const page = route.page;

  // Re-apply the theme the user saved in Settings (persisted in localStorage) on mount. The old
  // code blindly removed data-theme, which wiped the persisted choice and reset to system on load.
  useEffect(() => {
    applyTheme(readTheme());
  }, []);

  useEffect(() => {
    const onHash = () => {
      const next = readRouteFromHash();
      const raw = location.hash.replace(/^#\/?/, "");
      const canonical = canonicalHash(next);
      if (raw !== canonical) {
        location.hash = canonical;
        return;
      }
      setRoute(next);
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/healthz`);
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json() as HealthData;
        if (!cancelled) { setHealth(data); setHealthFailed(false); }
      } catch {
        if (!cancelled) setHealthFailed(true);
      }
    };
    void poll();
    const iv = setInterval(() => void poll(), 5000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

  const online = !healthFailed && health?.status === "ok";

  return (
    <div className="depas-app">
      <header className="depas-topbar">
        <div className="depas-brand">
          <span className="depas-brand-name">opencodex</span>
          {health?.version && <span className="depas-brand-ver">v{health.version}</span>}
        </div>
        <nav className="depas-nav" aria-label={t("shell.navAria")}>
          {NAV.map(({ id, labelKey }) => (
            <button
              key={id}
              type="button"
              className={`depas-nav-item${page === id ? " active" : ""}`}
              aria-current={page === id ? "page" : undefined}
              onClick={() => { location.hash = id; }}
            >
              {t(labelKey)}
            </button>
          ))}
        </nav>
        <div className="depas-topbar-actions">
          <span className={`stempel ${online ? "stempel--online" : "stempel--offline"}`} aria-live="polite">
            {online ? t("dash.online") : t("dash.offline")}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => setSheetOpen(true)}
            aria-label={t("dash.settingsSection")}
            aria-haspopup="dialog"
            aria-expanded={sheetOpen}
            title={t("dash.settingsSection")}
          >
            <IconSettings />
          </button>
        </div>
      </header>

      {!online && health !== null && (
        <div className="depas-offline-banner" role="alert">
          {t("shell.offlineBanner")}
        </div>
      )}

      <main className="depas-main">
        {page === "leveranciers" && <Providers apiBase={API_BASE} />}
        {page === "modellen" && <Modellen apiBase={API_BASE} target={route.target} />}
        {page === "verkeer" && <Verkeer apiBase={API_BASE} target={route.target} />}
        {page === "systeem" && <Systeem apiBase={API_BASE} health={health} healthFailed={healthFailed} target={route.target} />}
      </main>

      {sheetOpen && <InstellingenSheet apiBase={API_BASE} onClose={() => setSheetOpen(false)} />}
    </div>
  );
}
