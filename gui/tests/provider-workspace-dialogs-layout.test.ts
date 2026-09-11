import { expect, test } from "bun:test";

test("provider workspace dialogs compose from workspace-dialog primitives", async () => {
  const dialogs = await Bun.file(
    new URL("../src/components/provider-workspace/ProviderDialogs.tsx", import.meta.url),
  ).text();
  const primitive = await Bun.file(
    new URL("../src/components/primitives/workspace-dialog.tsx", import.meta.url),
  ).text();

  expect(dialogs).toContain("<WorkspaceDialogBackdrop");
  expect(dialogs).toContain("<WorkspaceDialog");
  expect(dialogs).toContain("<WorkspaceDialogTitle");
  expect(dialogs).toContain("<WorkspaceDialogBody");
  expect(dialogs).toContain("<WorkspaceDialogActions");
  expect(dialogs).not.toContain("dialog-backdrop");
  expect(dialogs).not.toContain('className="dialog"');
  expect(dialogs).not.toContain("dialog-actions");

  expect(primitive).toContain('className = "dialog-backdrop"');
  expect(primitive).toContain('className = "dialog"');
  expect(primitive).toContain('role = "alertdialog"');
  expect(primitive).toContain('className = "dialog-actions"');
  expect(primitive).toContain("stopPropagation");
});
