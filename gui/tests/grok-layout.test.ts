import { expect, test } from "bun:test";

test("Grok composes from named page, profile-bar, and group primitives", async () => {
  const page = await Bun.file(
    new URL("../src/pages/Grok.tsx", import.meta.url),
  ).text();

  expect(page).toContain("<GrokPage");
  expect(page).toContain("<GrokPageHeader");
  expect(page).toContain("<PageSubtitle");
  expect(page).toContain("<ProfileBar");
  expect(page).toContain("<CollapsibleGroupStack");
  expect(page).toContain("<CollapsibleGroup");
  expect(page).toContain("<CollapsibleGroupHead");
  expect(page).toContain("<CollapsibleGroupToggle");
  expect(page).toContain("<GrokModelRow");
  expect(page).not.toContain('className="page-head"');
  expect(page).not.toContain("<PageHeader");
  expect(page).not.toContain('className="claude-profile-bar"');
  expect(page).not.toContain("ocx-group-stack");
});
