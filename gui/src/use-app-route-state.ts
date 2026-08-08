import { useCallback, useEffect, useState } from "react";
import {
  canonicalHashFor,
  resolveAppHashChange,
  type Route,
} from "./app-routing";
import { navigateHash, normalizeHashPath, replaceHash } from "./hash-routing";

/** localStorage keys written by the removed Classic/Workspace preference. */
const STALE_VIEW_KEYS = [
  "ocx-global-view",
  "ocx-view",
  "ocx-providers-view",
  "ocx-subagents-view",
  "ocx-storage-view",
  "ocx-codexauth-view",
  "ocx-apikeys-view",
  "ocx-claudecode-view",
  "ocx-usage-view",
  "ocx-logs-view",
  "ocx-models-view",
  "ocx-dashboard-view",
];

/**
 * One-shot cleanup of the layout-preference keys. There is a single layout now, so these
 * would otherwise sit in every user's storage forever.
 * TODO: delete this function (and its call) one release after 2.7.x.
 */
function clearStaleViewKeys(): void {
  try {
    for (const key of STALE_VIEW_KEYS) localStorage.removeItem(key);
  } catch {
    /* private mode / quota — nothing to clean up */
  }
}

/**
 * Production App route ownership. Hash page changes push history; normalization of an
 * unknown sub-hash replaces the current entry so Back is never trapped on a URL the
 * router immediately rewrites.
 */
export function useAppRouteState() {
  // The first hash must go through the same resolver as `hashchange`: legacy
  // hashes (`#codex-auth/accounts`, `#dashboard/models`) land on their new view.
  const [route, setRoute] = useState<Route>(() =>
    resolveAppHashChange(
      normalizeHashPath(typeof window === "undefined" ? "" : window.location.hash),
    ).route,
  );

  useEffect(() => { clearStaleViewKeys(); }, []);

  const applyHashAction = useCallback((rawHash: string) => {
    const action = resolveAppHashChange(rawHash);
    if (action.replaceTo) replaceHash(action.replaceTo);
    setRoute(action.route);
  }, []);

  const navigateTo = (next: Route) => {
    navigateHash(canonicalHashFor(next));
    setRoute(next);
  };

  useEffect(() => {
    const onRouteHash = () => {
      applyHashAction(normalizeHashPath(window.location.hash));
    };
    // hashchange covers location.hash assignment; popstate covers Back/Forward.
    window.addEventListener("hashchange", onRouteHash);
    window.addEventListener("popstate", onRouteHash);
    return () => {
      window.removeEventListener("hashchange", onRouteHash);
      window.removeEventListener("popstate", onRouteHash);
    };
  }, [applyHashAction]);

  useEffect(() => {
    // Honour the resolver's rewrite on mount too: a legacy hash (#dashboard,
    // #codex-auth/accounts) is replaced by its canonical view hash right away,
    // passively, so Back never traps on the redirect.
    const action = resolveAppHashChange(normalizeHashPath(window.location.hash));
    if (action.replaceTo) replaceHash(action.replaceTo);
  }, [route]);

  return {
    route,
    navigateTo,
  };
}
