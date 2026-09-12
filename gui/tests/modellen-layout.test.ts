import { expect, test } from "bun:test";

test("Modellen composes from page header and segmented tab primitives", async () => {
  const page = await Bun.file(
    new URL("../src/pages/Modellen.tsx", import.meta.url),
  ).text();

  expect(page).toContain('className="ocx-page-root"');
  expect(page).toContain("<PageHeader");
  expect(page).toContain("<PageSubtitle");
  expect(page).toContain("<PageTabs");
  expect(page).toContain("<PageTab");
  expect(page).toContain("<ModellenTabPanel");
  expect(page).toContain('className="usage-segmented"');
  expect(page).toContain("usage-segmented-btn");
  expect(page).not.toContain('role="tablist"');
  expect(page).not.toContain('className="page-head"');
});
