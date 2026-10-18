import { expect, test } from "bun:test";
import { KNOWN_VIEW_HASHES, readRouteFromHash } from "../src/app-routing";
import { SUB_TABS, VIEW_TABS, routeTitleKey } from "../src/app/navigation";

test("every canonical view and subview has one navigation owner", () => {
  const rootViews = VIEW_TABS.map((item) => item.view);
  expect(rootViews.length).toBe(new Set(rootViews).size);
  for (const hash of KNOWN_VIEW_HASHES) {
    const route = readRouteFromHash(hash);
    expect(SUB_TABS[route.view].some((item) => item.sub === route.sub)).toBe(true);
    if (route.view !== "landing") expect(routeTitleKey(route)).not.toBeNull();
  }
  expect(routeTitleKey({ view: "landing", sub: null })).toBeNull();
});

test("route outlet contains only route composition, never global health or auth polling", async () => {
  const source = await Bun.file(new URL("../src/app/RouteOutlet.tsx", import.meta.url)).text();
  const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  expect(source).toContain('lazy(() => import("../pages/');
  expect(source).not.toContain('import("./pages/');
  expect(source).not.toContain("useKeyedClientResource");
  expect(source).not.toContain("installApiAuthFetch");
  const shell = await Bun.file(new URL("../src/app/DashboardShell.tsx", import.meta.url)).text();
  expect(app).toContain("<DashboardShell");
  expect(shell).toContain("<RouteOutlet route={route} />");
});

test("navigation metadata depends on app contracts, never UI component modules", async () => {
  const nav = await Bun.file(new URL("../src/app/navigation.ts", import.meta.url)).text();
  const contracts = await Bun.file(new URL("../src/app/navigation-contracts.ts", import.meta.url)).text();
  const primary = await Bun.file(new URL("../src/components/WorkspaceNavigation.tsx", import.meta.url)).text();
  const secondary = await Bun.file(new URL("../src/components/WorkspaceSubTabs.tsx", import.meta.url)).text();
  expect(nav).toContain('from "./navigation-contracts"');
  expect(nav).not.toContain('from "../components/WorkspaceNavigation"');
  expect(nav).not.toContain('from "../components/WorkspaceSubTabs"');
  expect(contracts).toContain("export interface WorkspaceDestination");
  expect(contracts).toContain("export interface WorkspaceSubTab");
  expect(primary).toContain('from "../app/navigation-contracts"');
  expect(secondary).toContain('from "../app/navigation-contracts"');
});

test("i18n lint covers moved application and feature UI source", async () => {
  const { I18N_UI_FILES } = await import("../.eslint/i18n-file-groups");
  expect(I18N_UI_FILES).toContain("src/app/**/*.{ts,tsx}");
  expect(I18N_UI_FILES).toContain("src/features/**/*.{ts,tsx}");
});
