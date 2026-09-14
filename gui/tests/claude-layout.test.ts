import { expect, test } from "bun:test";

test("Claude composes from named page and tab primitives", async () => {
  const page = await Bun.file(
    new URL("../src/pages/Claude.tsx", import.meta.url),
  ).text();

  expect(page).toContain("<ClaudePage");
  expect(page).toContain("<PageTabs");
  expect(page).toContain("<PageTab");
  expect(page).toContain("<PageTabPanel");
  expect(page).toContain('className="claude-tabs"');
  expect(page).toContain('className={tab === "code" ? "active" : ""}');
  expect(page).not.toContain('role="tablist"');
  expect(page).not.toContain("<button");
});
