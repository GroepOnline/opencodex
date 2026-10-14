import { lazy, Suspense, useEffect } from "react";
import ErrorBoundary from "./components/ErrorBoundary";
import { useT } from "./i18n/shared";
import { installApiAuthFetch } from "./api";
import { useAppRouteState } from "./use-app-route-state";
import { routeTitleKey } from "./app/navigation";
import { useAppTheme } from "./app/use-app-theme";
import DashboardShell from "./app/DashboardShell";

const Landing = lazy(() => import("./landing/Landing"));
installApiAuthFetch();

export default function App() {
  const { route, navigateTo } = useAppRouteState();
  const { theme, setTheme } = useAppTheme();
  const t = useT();
  useEffect(() => {
    const title = routeTitleKey(route);
    document.title = title ? t("app.pageTitle", { page: t(title) }) : "opencodex";
  }, [route, t]);
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
