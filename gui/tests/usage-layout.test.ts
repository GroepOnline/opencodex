import { expect, test } from "bun:test";
import { localeSource, SHIPPED_LOCALES } from "./helpers/locales";

test("Verkeer (usage) renders the single stacked layout (no layout toggle, no workspace rail)", async () => {
  const page = await Bun.file(
    new URL("../src/pages/Usage.tsx", import.meta.url),
  ).text();
  const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  const css = await Bun.file(
    new URL("../src/styles.css", import.meta.url),
  ).text();

  expect(page).not.toContain("viewMode");
  expect(page).not.toContain("readViewMode");
  expect(page).not.toContain("ocx-usage-view");
  expect(page).not.toContain("UsageWorkspaceBody");
  expect(page).not.toContain("UsageWorkspaceSection");
  expect(page).not.toContain("usage-workspace-");
  expect(page).not.toContain("usw-");
  expect(page).not.toContain("selectedSection");

  // App renders the Verkeer page (design-system v2 IA) for the verkeer view;
  // the legacy Usage page is no longer wired into the app shell.
  expect(app).toContain("<Verkeer apiBase={API_BASE}");
  expect(css).not.toContain("styles-usage-workspace.css");
});

test("Usage stacked layout mounts every report panel in order", async () => {
  const src = await Bun.file(
    new URL("../src/pages/Usage.tsx", import.meta.url),
  ).text();

  const order = [
    "<UsageSummaryCards",
    "<UsageQualityPanel",
    "<UsageHeatmapPanel",
    "<UsageModelsTable",
    "<UsageProvidersTable",
    "<UsageCoveragePanel",
  ];
  let cursor = -1;
  for (const marker of order) {
    const at = src.indexOf(marker);
    expect(at).toBeGreaterThan(cursor);
    cursor = at;
  }

  // Classic panels keep their section landmarks and headings via Panel/PanelHeader.
  expect(src).toContain("<Panel");
  expect(src).toContain("<PanelHeader");
  expect(src).toContain('t("usage.section.proxyUsage")');
  expect(src).toContain('t("usage.section.quality")');

  const titleIds: string[] = [];
  const panelBlocks = [
    ...src.matchAll(
      /function Usage\w+[\s\S]*?(?=function Usage|\nexport default)/g,
    ),
  ];
  expect(panelBlocks.length).toBeGreaterThanOrEqual(6);
  for (const [block] of panelBlocks) {
    if (!block.includes("<Panel")) continue;
    const declared = block.match(/const titleId = "([^"]+)"/);
    const panelLiteral = block.match(/<Panel\s+titleId="([^"]+)"/);
    const headerLiteral = block.match(/<PanelHeader[\s\S]*?titleId="([^"]+)"/);
    const id = panelLiteral?.[1] ?? declared?.[1];
    expect(id).toBeDefined();
    expect(titleIds).not.toContain(id);
    titleIds.push(id!);
    if (panelLiteral) expect(headerLiteral?.[1]).toBe(id);
    else {
      expect(block).toContain("<Panel titleId={titleId}");
      expect(block).toMatch(/<PanelHeader[\s\S]*titleId=\{titleId\}/);
    }
  }
  expect(titleIds).toEqual([
    "usage-proxy-title",
    "usage-quality-title",
    "usage-heatmap-title",
    "usage-models-title",
    "usage-providers-title",
    "usage-coverage-title",
  ]);
});

test("Usage loading and empty states guard the stacked body", async () => {
  const src = await Bun.file(
    new URL("../src/pages/Usage.tsx", import.meta.url),
  ).text();
  expect(src).toContain("loading && !data");
  expect(src).toContain('t("usage.loading")');
  expect(src).toContain('t("usage.empty")');
  expect(src).toContain("data?.summary.requests === 0");
});

test("retired usage workspace i18n keys stay removed from every locale", async () => {
  for (const locale of SHIPPED_LOCALES) {
    const dict = await localeSource(locale);
    expect(dict).not.toContain('"usage.workspace.sections":');
    expect(dict).not.toContain('"usage.workspace.report":');
    expect(dict).not.toContain('"usage.workspace.mainAria":');
  }
});

test("Usage subtitle composes from PageHeader description", async () => {
  const src = await Bun.file(
    new URL("../src/pages/Usage.tsx", import.meta.url),
  ).text();
  expect(src).toContain("<PageHeader");
  expect(src).toContain('description={t("usage.subtitle")}');
  expect(src).toContain("<Empty");
  expect(src).toContain("<EmptyTitle");
  expect(src).not.toContain("<PageSubtitle");
});
