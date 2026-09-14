import { expect, test } from "bun:test";

test("Combos page shell composes from named workspace chrome", async () => {
  const page = await Bun.file(
    new URL("../src/pages/Combos.tsx", import.meta.url),
  ).text();

  expect(page).toContain("function CombosWorkspaceShell");
  expect(page).toContain("function CombosWorkspaceBanner");
  expect(page).toContain("function CombosWorkspaceLoadingStatus");
  expect(page).toContain("function CombosWorkspaceBody");
  expect(page).toContain("<CombosWorkspaceShell");
  expect(page).toContain("<CombosWorkspaceBanner");
  expect(page).toContain("<CombosWorkspaceLoadingStatus");
  expect(page).toContain("<CombosWorkspaceBody");
  expect(page).toContain('className="combos-workspace-shell ocx-page-root"');
  expect(page).toContain('className="combos-workspace-shell-banner"');
  expect(page).toContain('className="combos-workspace-shell-body"');
  expect(page).toContain('role="status"');
  expect(page).toContain("<ComboWorkspace");
});
