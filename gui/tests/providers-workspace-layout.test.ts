import { expect, test } from "bun:test";

test("Providers page composes from PageHeader, StatStrip, StatusDot, and Empty", async () => {
  const page = await Bun.file(
    new URL("../src/pages/Providers.tsx", import.meta.url),
  ).text();
  const rail = await Bun.file(
    new URL("../src/components/provider-workspace/ProviderRail.tsx", import.meta.url),
  ).text();
  const overview = await Bun.file(
    new URL(
      "../src/components/provider-workspace/ProviderOverviewDashboard.tsx",
      import.meta.url,
    ),
  ).text();
  const shell = await Bun.file(
    new URL(
      "../src/components/provider-workspace/ProviderWorkspaceShell.tsx",
      import.meta.url,
    ),
  ).text();
  const details = await Bun.file(
    new URL(
      "../src/components/provider-workspace/ProviderDetails.tsx",
      import.meta.url,
    ),
  ).text();

  expect(page).toContain("<PageHeader");
  expect(page).toContain('className="providers-page ocx-page-root"');
  expect(page).toContain('description={t("prov.subtitle")}');
  expect(page).not.toContain('className="page-head"');

  expect(rail).toContain("<StatusDot");
  expect(rail).toContain("railStatusTone");

  expect(overview).toContain("<StatStrip");
  expect(overview).toContain("<StatStripItem");
  expect(overview).toContain("<SectionHeader");
  expect(overview).toContain("<Status");
  expect(overview).toContain('tone="error"');
  expect(overview).toContain("pws-quota-error-card");
  expect(overview).toContain("btn btn-ghost btn-sm");
  expect(overview).not.toContain("quota-card-error");
  expect(overview).toContain("<Empty");
  expect(overview).toContain("ocx-reveal-list");

  expect(shell).toContain("ocx-reveal-list");
  expect(shell).toContain("<Empty");
  expect(shell).toContain('className="pws-rail-group-head caps"');

  expect(details).toContain("<PageTabs");
  expect(details).toContain("<PageTab");
  expect(details).toContain("pws-detail-tab--active");
});

test("Claude page keeps PageTabs as the Code/Desktop strip", async () => {
  const page = await Bun.file(
    new URL("../src/pages/Claude.tsx", import.meta.url),
  ).text();
  expect(page).toContain("<PageTabs");
  expect(page).toContain("<PageTab");
  expect(page).toContain("<PageTabPanel");
  expect(page).toContain('className="claude-tabs"');
  expect(page).toContain('className="claude-page ocx-page-root"');
  expect(page).not.toContain("<PageHeader");
  expect(page).not.toContain('role="tablist"');
  expect(page).not.toContain("<button");
});
