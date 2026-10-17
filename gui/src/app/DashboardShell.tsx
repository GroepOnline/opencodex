import { Suspense, useRef, useState } from "react";
import ErrorBoundary from "../components/ErrorBoundary";
import SettingsSheet from "../components/SettingsSheet";
import SkipLink from "../components/SkipLink";
import { useT } from "../i18n/shared";
import { canonicalHashFor, type Route } from "../app-routing";
import { domMax, LazyMotion, MotionConfig } from "motion/react";
import WorkspaceSubTabs from "../components/WorkspaceSubTabs";
import { SUB_TABS } from "./navigation";
import { useShellStatus } from "./use-shell-status";
import ProductHeader from "./header/ProductHeader";
import OfflineBanner from "./OfflineBanner";
import RouteOutlet from "./RouteOutlet";
import DangerZone from "../features/system/components/DangerZone";
import type { Theme } from "./use-app-theme";

/** Render dashboard navigation and status polling with a page error boundary reset per route. */
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
  const { displayedVersion, proxyOnline, identityEmail } = useShellStatus();

  const activeTkey =
    SUB_TABS[route.view].find((s) => s.sub === route.sub)?.tkey ??
    "nav.providers";

  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={domMax} strict>
        <div className="app ocx-workspace">
          <SkipLink targetId="main-content">{t("app.skipToContent")}</SkipLink>
          <ProductHeader
            activeView={route.view}
            navigateTo={navigateTo}
            version={displayedVersion}
            proxyOnline={proxyOnline}
            identityEmail={identityEmail}
            settingsTriggerRef={settingsTriggerRef}
            onOpenSettings={(instant) => {
              setSettingsInstant(instant);
              setSettingsOpen(true);
            }}
          />

          {proxyOnline === false && (
            <OfflineBanner
              onOpenSystem={() => navigateTo({ view: "systeem", sub: null })}
            />
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
                  clientSha={__APP_GIT_SHA__}
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
