import type { Route, View } from "../app-routing";
import type { TKey } from "../i18n/shared";
import type { WorkspaceDestination, WorkspaceSubTab } from "./navigation-contracts";
import { IconActivity, IconBoxes, IconGrid, IconList, IconMonitor, IconServer } from "../icons";

/** One canonical view/sub-view catalog; URL compatibility stays in app-routing. */
export const VIEW_TABS: WorkspaceDestination[] = [
  { view: "dashboard", tkey: "nav.dashboard", icon: IconGrid },
  { view: "leveranciers", tkey: "nav.providers", icon: IconServer },
  { view: "modellen", tkey: "nav.models", icon: IconBoxes },
  { view: "verkeer", tkey: "nav.verkeer", icon: IconList },
  { view: "verbruik", tkey: "nav.usage", icon: IconActivity },
  { view: "systeem", tkey: "nav.systeem", icon: IconMonitor },
];

/** Sub-tabs per view; `null` is the view's home target. */
export const SUB_TABS: Record<View, WorkspaceSubTab[]> = {
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

export function routeTitleKey(route: Route): TKey | null {
  if (route.view === "landing") return null;
  if (route.sub === null) return VIEW_TABS.find((item) => item.view === route.view)?.tkey ?? null;
  return SUB_TABS[route.view].find((item) => item.sub === route.sub)?.tkey ?? null;
}
