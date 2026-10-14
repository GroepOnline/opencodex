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
  expect(app).toContain("<RouteOutlet route={route} />");
});
