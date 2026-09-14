import { expect, test } from "bun:test";

test("workspace inner tabs compose from PageTabs primitives", async () => {
  const catalog = await Bun.file(
    new URL(
      "../src/components/provider-catalog/ProviderCatalog.tsx",
      import.meta.url,
    ),
  ).text();
  const details = await Bun.file(
    new URL(
      "../src/components/provider-workspace/ProviderDetails.tsx",
      import.meta.url,
    ),
  ).text();
  const combos = await Bun.file(
    new URL(
      "../src/components/combo-workspace-detail-panel.tsx",
      import.meta.url,
    ),
  ).text();

  expect(catalog).toMatch(/<PageTabs(?:\s|>)/);
  expect(catalog).toMatch(/<PageTab(?:\s|>)/);
  expect(catalog).toMatch(/<PageTabPanel(?:\s|>)/);
  expect(catalog).toContain('className="provider-catalog-tabs"');
  expect(catalog).toContain("provider-catalog-tab");
  expect(catalog).toContain('className="provider-catalog-rows"');
  expect(catalog).not.toContain('role="tablist"');

  expect(details).toMatch(/<PageTabs(?:\s|>)/);
  expect(details).toMatch(/<PageTab(?:\s|>)/);
  expect(details).toMatch(/<PageTabPanel(?:\s|>)/);
  expect(details).toContain('className="pws-detail-tabs"');
  expect(details).toContain("pws-detail-tab--active");
  expect(details).toContain('className="pws-detail-panel"');
  expect(details).toContain(
    "onKeyDown={(event) => onTabKeyDown(event, index)}",
  );
  expect(details).not.toContain('role="tablist"');

  expect(combos).toMatch(/<PageTabs(?:\s|>)/);
  expect(combos).toMatch(/<PageTab(?:\s|>)/);
  expect(combos).toMatch(/<PageTabPanel(?:\s|>)/);
  expect(combos).toContain('className="combos-workspace-tabs"');
  expect(combos).toContain("combos-workspace-tab--active");
  expect(combos).toContain('className="combos-workspace-tab-content"');
  expect(combos).toContain('label={t("nav.combos")}');
  expect(combos).not.toContain('role="tablist"');
});
