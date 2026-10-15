import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceUpdateGuidance } from "../src/update/index";

const dirs: string[] = [];
function fixture(head: string, linked: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-updater-source-"));
  dirs.push(root);
  const checkout = join(root, "cli-7d483b9");
  mkdirSync(checkout);
  const gitDir = linked
    ? join(root, "repo", ".git", "worktrees", "cli-7d483b9")
    : join(checkout, ".git");
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), head + "\n");
  if (linked) writeFileSync(join(checkout, ".git"), "gitdir: " + gitDir + "\n");
  return checkout;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
describe("ocx update source-checkout guidance", () => {
  test("detached Git worktrees cannot be updated by git pull", () => {
    const message = sourceUpdateGuidance(
      fixture("7d483b925ef49130ffb84df602c88e44cdddab00", true),
    );
    expect(message).toContain("detached");
    expect(message).not.toContain("git pull");
    expect(message).toContain("deployment");
  });
  test("detached ordinary checkouts cannot be updated by git pull", () => {
    const message = sourceUpdateGuidance(
      fixture("7d483b925ef49130ffb84df602c88e44cdddab00", false),
    );
    expect(message).toContain("detached");
    expect(message).not.toContain("git pull");
  });
  test("branch worktrees retain the source-update advice", () => {
    const message = sourceUpdateGuidance(fixture("ref: refs/heads/main", true));
    expect(message).toContain("git pull");
  });
});
