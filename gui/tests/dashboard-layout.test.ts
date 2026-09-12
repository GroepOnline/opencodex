import { expect, test } from "bun:test";

test("Dashboard composes from PageHeader, runtime strip, panels, and Empty", async () => {
  const page = await Bun.file(
    new URL("../src/pages/Dashboard.tsx", import.meta.url),
  ).text();
  const runtime = await Bun.file(
    new URL("../src/components/dashboard/runtime-summary.tsx", import.meta.url),
  ).text();
  const providers = await Bun.file(
    new URL("../src/components/dashboard/provider-usage-list.tsx", import.meta.url),
  ).text();
  const traffic = await Bun.file(
    new URL("../src/components/dashboard/request-activity-list.tsx", import.meta.url),
  ).text();

  expect(page).toContain("<PageHeader");
  expect(page).toContain('description={t("dash.subtitle")}');
  expect(page).toContain('className="dashboard-workspace ocx-page-root"');
  expect(page).toContain('href="#verkeer"');
  expect(page).toContain('href="#leveranciers"');
  expect(page).toContain("<RuntimeSummary");
  expect(page).toContain("<MetricList");
  expect(page).toContain("<ProviderUsageList");
  expect(page).toContain("<RequestActivityList");

  expect(runtime).toContain("<StatStrip");
  expect(runtime).toContain("<StatStripItem");
  expect(runtime).toContain("<StatusDot");

  expect(providers).toContain("<Panel");
  expect(providers).toContain("<PanelHeader");
  expect(providers).toContain("<Empty");
  expect(providers).toContain("<EmptyTitle");
  expect(providers).toContain("ocx-reveal-list");

  expect(traffic).toContain("<Panel");
  expect(traffic).toContain("<Empty");
  expect(traffic).toContain("ocx-reveal-list");
});
