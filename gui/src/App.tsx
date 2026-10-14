import { lazy, Suspense, useEffect, useRef, useState, type Ref } from "react";
import { useKeyedClientResource } from "./client-resource";
import ErrorBoundary from "./components/ErrorBoundary";
import SettingsSheet from "./components/SettingsSheet";
import SkipLink from "./components/SkipLink";
import {
  IconAlert,
  IconCheck,
  IconPower,
  IconSettings,
  IconUser,
} from "./icons";
import { useT } from "./i18n/shared";
import { installApiAuthFetch } from "./api";
import { canonicalHashFor } from "./app-routing";
import { VIEW_TABS, SUB_TABS, routeTitleKey } from "./app/navigation";
import RouteOutlet from "./app/RouteOutlet";
import { useAppRouteState } from "./use-app-route-state";
import { requestProxyStop } from "./stop-proxy";
import { loadSessionIdentity, type SessionIdentity } from "./session-identity";
import { domMax, LazyMotion, MotionConfig } from "motion/react";
import WorkspaceNavigation from "./components/WorkspaceNavigation";
import WorkspaceSubTabs from "./components/WorkspaceSubTabs";
import {
  Modal,
  ModalActions,
  ModalCard,
  ModalDesc,
  ModalHead,
} from "./components/primitives/modal";
const Landing = lazy(() => import("./landing/Landing"));

installApiAuthFetch();

type Theme = "light" | "dark" | "system";

const API_BASE = import.meta.env.VITE_API_BASE || "";
const THEME_KEY = "ocx-theme";

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
    const title = routeTitleKey(route);
    document.title = title ? t("app.pageTitle", { page: t(title) }) : "opencodex";
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
  const identityPoll = useKeyedClientResource<SessionIdentity>(
    `app-whoami:${API_BASE}`,
    [],
    () => loadSessionIdentity(),
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
      <LazyMotion features={domMax} strict>
        <div className="app ocx-workspace">
          <SkipLink targetId="main-content">{t("app.skipToContent")}</SkipLink>
          <header className="topbar">
            {brand}
            <WorkspaceNavigation
              destinations={VIEW_TABS}
              active={route.view}
              onNavigate={(view) => navigateTo({ view, sub: null })}
            />
            <div className="topbar-right">
              {identityPoll.data?.email ? (
                <span
                  className="session-identity"
                  aria-label={t("session.signedInAs", {
                    email: identityPoll.data.email,
                  })}
                  title={t("session.signedInAs", {
                    email: identityPoll.data.email,
                  })}
                >
                  <IconUser size={15} aria-hidden />
                  <span className="session-identity-email">
                    {identityPoll.data.email}
                  </span>
                </span>
              ) : null}
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

          <main id="main-content" className="main" tabIndex={-1}>
            <div
              className={`main-inner${route.view === "modellen" && route.sub === "combos" ? " main-inner--combos" : ""}`}
            >
              {SUB_TABS[route.view].length > 1 && (
                <WorkspaceSubTabs
                  tabs={SUB_TABS[route.view]}
                  active={route.sub}
                  label={t("nav.sections")}
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
                    <RouteOutlet route={route} />
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
