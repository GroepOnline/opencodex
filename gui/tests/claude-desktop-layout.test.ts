import { expect, test } from "bun:test";

test("Claude Desktop composes from page, profile-bar, and group primitives", async () => {
  const page = await Bun.file(
    new URL("../src/pages/ClaudeDesktop.tsx", import.meta.url),
  ).text();

  expect(page).toContain("<PageHeader");
  expect(page).toContain('className="claude-desktop-head"');
  expect(page).toContain('actionsClassName="claude-profile-tools"');
  expect(page).toContain("<ProfileBar");
  expect(page).toContain("<CollapsibleGroupStack");
  expect(page).toContain("<CollapsibleGroup");
  expect(page).toContain("<CollapsibleGroupHead");
  expect(page).toContain("<CollapsibleGroupToggle");
  expect(page).toContain("<ClaudeDesktopStatusBar");
  expect(page).toContain("<ClaudeLaneBody");
  expect(page).not.toContain('className="claude-profile-bar"');
  expect(page).not.toContain("ocx-group-stack");
});
