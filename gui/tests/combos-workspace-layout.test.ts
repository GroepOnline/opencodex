import { expect, test } from "bun:test";

test("Combos workspace composes rail and overview from named components", async () => {
  const workspace = await Bun.file(
    new URL("../src/components/ComboWorkspace.tsx", import.meta.url),
  ).text();
  const rail = await Bun.file(
    new URL("../src/components/combo-workspace-rail.tsx", import.meta.url),
  ).text();
  const overview = await Bun.file(
    new URL("../src/components/combo-workspace-overview-panel.tsx", import.meta.url),
  ).text();

  expect(workspace).toContain("<ComboWorkspaceRoot");
  expect(workspace).toContain("<ComboWorkspaceRail");
  expect(workspace).toContain("<ComboWorkspaceMain");
  expect(workspace).toContain("<OverviewPanel");
  expect(workspace).not.toContain("combos-workspace-rail-header");
  expect(workspace).not.toContain("<aside");

  expect(rail).toContain("combos-workspace-rail");
  expect(rail).toContain("combos-workspace-rail-header");
  expect(rail).toContain("cwi-search-input");
  expect(rail).toContain("combos-workspace-rail-row");
  expect(rail).toContain('aria-label={t("cws.railAria")}');

  expect(overview).toContain("<ComboOverviewHead");
  expect(overview).toContain("<ComboCountStrip");
  expect(overview).toContain("<ComboHowSection");
  expect(overview).toContain("<ComboAttentionSection");
  expect(overview).toContain("combos-workspace-overview-title");
});
