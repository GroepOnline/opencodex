import { expect, test } from "bun:test";

test("Storage composes from page, panel, tab, and modal primitives", async () => {
  const page = await Bun.file(
    new URL("../src/pages/Storage.tsx", import.meta.url),
  ).text();

  expect(page).toContain("<PageHeader");
  expect(page).toContain('titleId="storage-page-title"');
  expect(page).toContain('actionsClassName="storage-page-head-actions"');
  expect(page).toContain("<PageSubtitle");
  expect(page).toContain("<Panel");
  expect(page).toContain("<PanelHeader");
  expect(page).toContain('className="panel storage-cleanup-card"');
  expect(page).toContain("<PageTabs");
  expect(page).toContain("<PageTab");
  expect(page).toContain("<PageTabPanel");
  expect(page).toContain("<StorageConfirmDialog");
  expect(page).toContain("<Modal");
  expect(page).toContain("<ModalCard");
  expect(page).not.toContain('className="modal-overlay"');
  expect(page).not.toContain('className="page-head"');
});
