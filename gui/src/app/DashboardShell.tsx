import { Suspense, useRef, useState } from "react";
import { useKeyedClientResource } from "../client-resource";
import ErrorBoundary from "../components/ErrorBoundary";
import SettingsSheet from "../components/SettingsSheet";
import SkipLink from "../components/SkipLink";
import { IconAlert, IconCheck, IconSettings, IconUser } from "../icons";
import { useT } from "../i18n/shared";
import { canonicalHashFor, type Route } from "../app-routing";
import { loadSessionIdentity, type SessionIdentity } from "../session-identity";
import { domMax, LazyMotion, MotionConfig } from "motion/react";
import WorkspaceNavigation from "../components/WorkspaceNavigation";
import WorkspaceSubTabs from "../components/WorkspaceSubTabs";
import { VIEW_TABS, SUB_TABS } from "./navigation";
import RouteOutlet from "./RouteOutlet";
import DangerZone from "../features/system/components/DangerZone";
import type { Theme } from "./use-app-theme";

const API_BASE = import.meta.env.VITE_API_BASE || "";

function readRuntimeVersion(data: unknown): string | null {
  if (!data || typeof data !== "object" || !("version" in data)) return null;
  const version = (data as { version?: unknown }).version;
  return typeof version === "string" && version.length > 0 ? version : null;
}

export default function DashboardShell({
  route,
  navigateTo,
  theme,
  setTheme,
}: {
  route: Route;
  navigateTo: (next: Route) => void;
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

