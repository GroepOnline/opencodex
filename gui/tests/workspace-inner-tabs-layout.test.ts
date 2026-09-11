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

  expect(catalog).toContain("<PageTabs");
  expect(catalog).toContain("<PageTab");
  expect(catalog).toContain("<PageTabPanel");
  expect(catalog).toContain('className="provider-catalog-tabs"');
  expect(catalog).toContain("provider-catalog-tab");
  expect(catalog).toContain('className="provider-catalog-rows"');
  expect(catalog).not.toContain('role="tablist"');

  expect(details).toContain("<PageTabs");
  expect(details).toContain("<PageTab");
  expect(details).toContain("<PageTabPanel");
  expect(details).toContain('className="pws-detail-tabs"');
  expect(details).toContain("pws-detail-tab--active");
  expect(details).toContain('className="pws-detail-panel"');
  expect(details).toContain(
    "onKeyDown={(event) => onTabKeyDown(event, index)}",
  );
  expect(details).not.toContain('role="tablist"');

  expect(combos).toContain("<PageTabs");
  expect(combos).toContain("<PageTab");
  expect(combos).toContain("<PageTabPanel");
  expect(combos).toContain('className="combos-workspace-tabs"');
  expect(combos).toContain("combos-workspace-tab--active");
  expect(combos).toContain('className="combos-workspace-tab-content"');
  expect(combos).toContain('label={t("nav.combos")}');
  expect(combos).not.toContain('role="tablist"');
});
