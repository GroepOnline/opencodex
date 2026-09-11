import { expect, test } from "bun:test";

test("Startup composes from page, panel, and state primitives", async () => {
  const page = await Bun.file(
    new URL("../src/pages/Startup.tsx", import.meta.url),
  ).text();
  const sections = await Bun.file(
    new URL("../src/pages/startup-sections.tsx", import.meta.url),
  ).text();
  const header = await Bun.file(
    new URL("../src/components/primitives/page-header.tsx", import.meta.url),
  ).text();

  expect(page).toContain("<PageHeader");
  expect(page).toContain('actionsClassName="startup-page-head-actions"');
  expect(page).toContain('descriptionClassName="page-sub startup-page-sub"');
  expect(page).toContain("<StartupHeroSection");
  expect(page).toContain("<StartupDetailsSection");
  expect(page).toContain("<StartupRecoverySection");

  expect(sections).toContain("<Panel");
  expect(sections).toContain("<PanelHeader");
  expect(sections).toContain("<StatGroup");
  expect(sections).toContain("<StartupStateItem");
  expect(sections).toContain('className="stat"');
  expect(sections).toContain('className="label"');
  expect(sections).toContain('className="value"');
  expect(sections).not.toContain("<section className={`panel");
  expect(sections).not.toContain('<section className="panel');

  expect(header).toContain('actionsClassName = "page-head-actions"');
});
