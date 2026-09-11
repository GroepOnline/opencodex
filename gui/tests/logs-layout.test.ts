import { expect, test } from "bun:test";

test("Logs composes from page, tabs, toolbar, and modal primitives", async () => {
  const page = await Bun.file(
    new URL("../src/pages/Logs.tsx", import.meta.url),
  ).text();
  const tabs = await Bun.file(
    new URL("../src/components/primitives/page-tabs.tsx", import.meta.url),
  ).text();

  expect(page).toContain("<PageHeader");
  expect(page).toContain("<LogsAutoRefreshToggle");
  expect(page).toContain("<PageTabs");
  expect(page).toContain("<PageTab");
  expect(page).toContain("<PageTabPanel");
  expect(page).toContain("<LogsToolbar");
  expect(page).toContain("<LogsSurfaceFilter");
  expect(page).toContain("<LogsConversationFilter");
  expect(page).toContain("<LogDetailDialog");
  expect(page).toContain("<ModalDialog");
  expect(page).toContain("<ModalCard");
  expect(page).toContain("<ModalHead");
  expect(page).toContain("<LogDetailSection");
  expect(page).toContain('className="tbl logs-table"');
  expect(page).toContain('className="segmented logs-segmented"');
  expect(page).not.toContain('className="page-tabs"');
  expect(page).not.toContain("<dialog");

  expect(tabs).toContain('className = "page-tabs"');
  expect(tabs).toContain("page-tab--active");
});
