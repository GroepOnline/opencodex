import { lazy, Suspense, useEffect, useRef, useState, type Ref } from "react";
import { useKeyedClientResource } from "./client-resource";
import ErrorBoundary from "./components/ErrorBoundary";
import SettingsSheet from "./components/SettingsSheet";
import { IconAlert, IconCheck, IconPower, IconSettings } from "./icons";
import { useT } from "./i18n/shared";
import { installApiAuthFetch } from "./api";
import { canonicalHashFor, type View } from "./app-routing";
import { useAppRouteState } from "./use-app-route-state";
import { requestProxyStop } from "./stop-proxy";
import { domAnimation, LazyMotion, MotionConfig } from "motion/react";
import WorkspaceNavigation, {
  type WorkspaceDestination,
} from "./components/WorkspaceNavigation";
import WorkspaceSubTabs, {
  type WorkspaceSubTab,
} from "./components/WorkspaceSubTabs";
import {
  Modal,
  ModalActions,
  ModalCard,
  ModalDesc,
  ModalHead,
} from "./components/primitives/modal";
import {
  IconActivity,
  IconBoxes,
  IconGrid,
  IconList,
  IconMonitor,
  IconServer,
} from "./icons";

const Providers = lazy(() => import("./pages/Providers"));
const Models = lazy(() => import("./pages/Models"));
const Combos = lazy(() => import("./pages/Combos"));
const Subagents = lazy(() => import("./pages/Subagents"));
const Verkeer = lazy(() => import("./pages/Verkeer"));
const Debug = lazy(() => import("./pages/Debug"));
const Usage = lazy(() => import("./pages/Usage"));
const Storage = lazy(() => import("./pages/Storage"));
const ApiKeys = lazy(() => import("./pages/ApiKeys"));
const Claude = lazy(() => import("./pages/Claude"));
const Grok = lazy(() => import("./pages/Grok"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Startup = lazy(() => import("./pages/Startup"));
const Landing = lazy(() => import("./landing/Landing"));

installApiAuthFetch();

type Theme = "light" | "dark" | "system";

const API_BASE = import.meta.env.VITE_API_BASE || "";
const THEME_KEY = "ocx-theme";

const VIEW_TABS: WorkspaceDestination[] = [
  { view: "dashboard", tkey: "nav.dashboard", icon: IconGrid },
  { view: "leveranciers", tkey: "nav.providers", icon: IconServer },
  { view: "modellen", tkey: "nav.models", icon: IconBoxes },
  { view: "verkeer", tkey: "nav.verkeer", icon: IconList },
  { view: "verbruik", tkey: "nav.usage", icon: IconActivity },
  { view: "systeem", tkey: "nav.systeem", icon: IconMonitor },
];

/** Sub-tabs per view; `null` is the view's home target. */
const SUB_TABS: Record<View, WorkspaceSubTab[]> = {
  landing: [{ sub: null, tkey: "nav.dashboard" }],
  dashboard: [{ sub: null, tkey: "nav.dashboard" }],
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
    { sub: null, tkey: "sub.logs" },
    { sub: "debug", tkey: "sub.debug" },
  ],
  verbruik: [{ sub: null, tkey: "nav.usage" }],
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
  useEffect(() => {
    const title =
      route.sub === null
        ? VIEW_TABS.find((entry) => entry.view === route.view)?.tkey
        : SUB_TABS[route.view].find((entry) => entry.sub === route.sub)?.tkey;
    document.title =
      title && route.view !== "landing"
        ? t("app.pageTitle", { page: t(title) })
        : "opencodex";
  }, [route, t]);
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

  // The public landing page renders outside the dashboard shell: no topbar,
  // no view tabs, no health polling UI. Everything below it is the app.
  if (route.view === "landing") {
    return (
      <ErrorBoundary
        pageName="OpenCodex"
        title={t("errorBoundary.title")}
        message={t("errorBoundary.message")}
        detailsLabel={t("errorBoundary.details")}
        reloadLabel={t("errorBoundary.reload")}
      >
        <Suspense
          fallback={
            <div className="muted" role="status">
              {t("common.loading")}
            </div>
          }
        >
          <Landing />
        </Suspense>
      </ErrorBoundary>
    );
  }

  return (
    <DashboardShell
      route={route}
      navigateTo={navigateTo}
      theme={theme}
      setTheme={setTheme}
    />
  );
}

function DashboardShell({
  route,
  navigateTo,
  theme,
  setTheme,
}: {
  route: ReturnType<typeof useAppRouteState>["route"];
  navigateTo: ReturnType<typeof useAppRouteState>["navigateTo"];
  theme: Theme;
  setTheme: (theme: Theme) => void;
}) {
  const t = useT();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInstant, setSettingsInstant] = useState(false);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const healthPoll = useKeyedClientResource(
    `app-healthz:${API_BASE}`,
    [],
    async (signal) => {
      const res = await fetch(`${API_BASE}/healthz`, { signal });
      // Non-OK healthz is a technical fetch failure — the status code is the payload.
      if (!res.ok) throw new Error(String(res.status));
      return { version: readRuntimeVersion(await res.json()) };
    },
    { pollMs: 30_000 },
  );

  const displayedVersion: string = healthPoll.data?.version ?? __APP_VERSION__;
  // null = first poll still in flight: no stamp until the first verdict.
  const proxyOnline: boolean | null = healthPoll.error
    ? false
    : healthPoll.data
      ? true
      : null;

  const activeTkey =
    SUB_TABS[route.view].find((s) => s.sub === route.sub)?.tkey ??
    "nav.providers";

  const brand = (
    <div className="brand">
      <span className="brand-logo" role="img" aria-label={t("app.logoAria")} />
      <span className="name">opencodex</span>
      <span className="ver">v{displayedVersion}</span>
    </div>
  );

  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={domAnimation} strict>
        <div className="app ocx-workspace">
          <header className="topbar">
            {brand}
            <WorkspaceNavigation
              destinations={VIEW_TABS}
              active={route.view}
              onNavigate={(view) => navigateTo({ view, sub: null })}
            />
            <div className="topbar-right">
              {proxyOnline !== null && (
                <span
                  className={`stamp${proxyOnline ? " stamp-ok" : " stamp-err"}`}
                  role="status"
                >
                  {proxyOnline ? (
                    <IconCheck size={13} aria-hidden />
                  ) : (
                    <IconAlert size={13} aria-hidden />
                  )}
                  {t(proxyOnline ? "proxy.online" : "proxy.offline")}
                </span>
              )}
              <button
                ref={settingsTriggerRef}
                type="button"
                className="gbtn"
                onClick={(event) => {
                  setSettingsInstant(event.detail === 0);
                  setSettingsOpen(true);
                }}
                aria-label={t("settings.open")}
                title={t("settings.open")}
              >
                <IconSettings />
              </button>
            </div>
          </header>

          {proxyOnline === false && (
            <div className="offline-banner" role="alert">
              <IconAlert size={15} aria-hidden />
              <span>{t("offline.banner")}</span>
              <button
                type="button"
                className="link-btn"
                onClick={() => navigateTo({ view: "systeem", sub: null })}
              >
                {t("offline.toSystem")}
              </button>
            </div>
          )}

          <main className="main">
            <div
              className={`main-inner${route.view === "modellen" && route.sub === "combos" ? " main-inner--combos" : ""}`}
            >
              {SUB_TABS[route.view].length > 1 && (
                <WorkspaceSubTabs
                  tabs={SUB_TABS[route.view]}
                  active={route.sub}
                  label={t(activeTkey)}
                  onNavigate={(sub) => navigateTo({ view: route.view, sub })}
                />
              )}
              <div key={canonicalHashFor(route)} className="ocx-page">
                <ErrorBoundary
                  pageName={t(activeTkey)}
                  title={t("errorBoundary.title")}
                  message={t("errorBoundary.message")}
                  detailsLabel={t("errorBoundary.details")}
                  reloadLabel={t("errorBoundary.reload")}
                >
                  <Suspense
                    fallback={
                      <div className="muted" role="status">
                        {t("common.loading")}
                      </div>
                    }
                  >
                    {route.view === "dashboard" && (
                      <Dashboard apiBase={API_BASE} />
                    )}
                    {route.view === "leveranciers" && route.sub === null && (
                      <Providers apiBase={API_BASE} />
                    )}
                    {route.view === "leveranciers" &&
                      route.sub === "claude" && <Claude apiBase={API_BASE} />}
                    {route.view === "leveranciers" && route.sub === "grok" && (
                      <Grok apiBase={API_BASE} />
                    )}
                    {route.view === "modellen" && route.sub === null && (
                      <Models apiBase={API_BASE} />
                    )}
                    {route.view === "modellen" && route.sub === "combos" && (
                      <Combos key={API_BASE} apiBase={API_BASE} />
                    )}
                    {route.view === "modellen" && route.sub === "subagents" && (
                      <Subagents key={API_BASE} apiBase={API_BASE} />
                    )}
                    {route.view === "verkeer" && route.sub === "debug" && (
                      <Debug apiBase={API_BASE} />
                    )}
                    {route.view === "verkeer" && route.sub !== "debug" && (
                      <Verkeer apiBase={API_BASE} />
                    )}
                    {route.view === "verbruik" && <Usage apiBase={API_BASE} />}
                    {route.view === "systeem" && route.sub === null && (
                      <Startup apiBase={API_BASE} />
                    )}
                    {route.view === "systeem" && route.sub === "storage" && (
                      <Storage apiBase={API_BASE} />
                    )}
                    {route.view === "systeem" && route.sub === "api" && (
                      <ApiKeys apiBase={API_BASE} />
                    )}
                  </Suspense>
                </ErrorBoundary>
              </div>
              {route.view === "systeem" && route.sub === null && <DangerZone />}
            </div>
          </main>

          <SettingsSheet
            open={settingsOpen}
            instant={settingsInstant}
            returnFocusRef={settingsTriggerRef}
            theme={theme}
            onTheme={setTheme}
            onClose={() => setSettingsOpen(false)}
          />
        </div>
      </LazyMotion>
    </MotionConfig>
  );
}

/** Danger zone (Systeem home): destructive actions live here — named, separated,
    and behind an explicit confirmation. Never in navigation. */
function StopProxyDialog({
  stopping,
  cancelRef,
  title,
  body,
  cancelLabel,
  stopLabel,
  stoppingLabel,
  onCancel,
  onConfirm,
}: {
  stopping: boolean;
  cancelRef: Ref<HTMLButtonElement>;
  title: string;
  body: string;
  cancelLabel: string;
  stopLabel: string;
  stoppingLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      role="alertdialog"
      aria-labelledby="stop-proxy-title"
      aria-describedby="stop-proxy-desc"
      onClick={(e) => {
        if (e.target === e.currentTarget && !stopping) onCancel();
      }}
    >
      <ModalCard className="modal-card modal-card--narrow">
        <ModalHead titleId="stop-proxy-title" title={title} />
        <ModalDesc id="stop-proxy-desc">{body}</ModalDesc>
        <ModalActions>
          <button
            ref={cancelRef}
            type="button"
            className="btn"
            onClick={onCancel}
            disabled={stopping}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={onConfirm}
            disabled={stopping}
          >
            <IconPower size={13} aria-hidden />{" "}
            {stopping ? stoppingLabel : stopLabel}
          </button>
        </ModalActions>
      </ModalCard>
    </Modal>
  );
}

function DangerZone() {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!confirming) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !stopping) setConfirming(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming, stopping]);

  const handleStop = async () => {
    setStopping(true);
    const outcome = await requestProxyStop(API_BASE, {
      formatFailure: (status) =>
        t("dash.stopFailed", { status: String(status) }),
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
      <h3 id="danger-zone-title" className="danger-title">
        {t("danger.title")}
      </h3>
      <div className="danger-row">
        <div className="danger-copy">
          <div className="danger-action">{t("danger.stopAction")}</div>
          <div className="muted">{t("danger.stopBody")}</div>
        </div>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => setConfirming(true)}
        >
          <IconPower size={13} aria-hidden /> {t("dash.stop")}
        </button>
      </div>

      {confirming && (
        <StopProxyDialog
          stopping={stopping}
          cancelRef={cancelRef}
          title={t("danger.stopTitle")}
          body={t("danger.stopBody")}
          cancelLabel={t("common.cancel")}
          stopLabel={t("danger.stopAction")}
          stoppingLabel={t("dash.stopping")}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void handleStop()}
        />
      )}
    </section>
  );
}
