import { expect, test } from "bun:test";

test("Storage composes from page, panel, tab, and modal primitives", async () => {
  // The Storage feature spans the page plus its extracted storage-workspace
  // components; assert over the combined source.
  const sources = await Promise.all(
    [
      "../src/pages/Storage.tsx",
      "../src/components/storage-workspace/storage-cleanup-card.tsx",
      "../src/components/storage-workspace/storage-confirm.tsx",
      "../src/components/storage-workspace/archived-cleanup-panel.tsx",
      "../src/components/storage-workspace/quarantine-trash-panel.tsx",
      "../src/components/storage-workspace/auto-cleanup-policy-panel.tsx",
    ].map((path) => Bun.file(new URL(path, import.meta.url)).text()),
  );
  const page = sources.join("\n");

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
