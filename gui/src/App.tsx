import { useEffect, useState } from "react";
import Providers from "./pages/Providers";
import Modellen from "./pages/Modellen";
import Verkeer from "./pages/Verkeer";
import Systeem from "./pages/Systeem";
import InstellingenSheet from "./pages/Instellingen";
import { IconSettings } from "./icons";
import { installApiAuthFetch } from "./api";

installApiAuthFetch();

type Page = "leveranciers" | "modellen" | "verkeer" | "systeem";

const VALID_PAGES = new Set<Page>(["leveranciers", "modellen", "verkeer", "systeem"]);

/** Legacy deep links from the old 11-page shell land on the view that absorbed them. */
const LEGACY_ROUTES: Record<string, Page> = {
  dashboard: "systeem",
  providers: "leveranciers",
  models: "modellen",
  combos: "modellen",
  subagents: "modellen",
  logs: "verkeer",
  debug: "verkeer",
  usage: "verkeer",
  storage: "systeem",
  "codex-auth": "systeem",
  api: "systeem",
  claude: "systeem",
};

function readPageFromHash(): Page {
  const raw = location.hash.replace(/^#\/?/, "");
  const head = raw.split("/")[0];
  if (VALID_PAGES.has(head as Page)) return head as Page;
  return LEGACY_ROUTES[head] ?? "leveranciers";
}

const API_BASE = import.meta.env.VITE_API_BASE || "";

const NAV: { id: Page; label: string }[] = [
  { id: "leveranciers", label: "Leveranciers" },
  { id: "modellen", label: "Modellen" },
  { id: "verkeer", label: "Verkeer" },
  { id: "systeem", label: "Systeem" },
];

interface HealthData { status: string; version: string; uptime: number }

export default function App() {
  const [page, setPageState] = useState<Page>(readPageFromHash);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [healthFailed, setHealthFailed] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  // One identity: the old dark theme attribute no longer applies.
  useEffect(() => {
    document.documentElement.removeAttribute("data-theme");
  }, []);

  useEffect(() => {
    const onHash = () => {
      const next = readPageFromHash();
      const raw = location.hash.replace(/^#\/?/, "");
      if (raw.split("/")[0] !== next) {
        location.hash = next;
        return;
      }
      setPageState(next);
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
        <nav className="depas-nav" aria-label="Hoofdnavigatie">
          {NAV.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={`depas-nav-item${page === id ? " active" : ""}`}
              aria-current={page === id ? "page" : undefined}
              onClick={() => { location.hash = id; }}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="depas-topbar-actions">
          <span className={`stempel ${online ? "stempel--online" : "stempel--offline"}`} aria-live="polite">
            {online ? "Online" : "Offline"}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => setSheetOpen(true)}
            aria-label="Instellingen"
            aria-haspopup="dialog"
            aria-expanded={sheetOpen}
            title="Instellingen"
          >
            <IconSettings />
          </button>
        </div>
      </header>

      {!online && health !== null && (
        <div className="depas-offline-banner" role="alert">
          Proxy offline. Codex en Cursor kunnen niet routeren.
        </div>
      )}

      <main className="depas-main">
        {page === "leveranciers" && <Providers apiBase={API_BASE} />}
        {page === "modellen" && <Modellen apiBase={API_BASE} />}
        {page === "verkeer" && <Verkeer apiBase={API_BASE} />}
        {page === "systeem" && <Systeem apiBase={API_BASE} health={health} healthFailed={healthFailed} />}
      </main>

      {sheetOpen && <InstellingenSheet apiBase={API_BASE} onClose={() => setSheetOpen(false)} />}
    </div>
  );
}
