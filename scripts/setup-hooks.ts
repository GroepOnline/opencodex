/**
 * Ensures Husky git hooks are active after clone.
 * Normally automatic via `bun install` → prepare → husky.
 * Run manually if hooks are missing: bun run setup:hooks
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

try {
  execFileSync("git", ["rev-parse", "--git-dir"], {
    cwd: repoRoot,
    stdio: "ignore",
  });
} catch {
  console.error("setup-hooks: must be run from inside a git repository.");
  process.exit(1);
}

execFileSync(process.execPath, ["x", "husky"], {
  cwd: repoRoot,
  stdio: "inherit",
});
console.log("Husky hooks installed (.husky/pre-commit and .husky/pre-push).");
console.log("Skip pre-commit in an emergency with: git commit --no-verify");
console.log(
  "Pre-push requires remote/isolated verification, or OCX_RUN_LOCAL_PREPUSH=1 for an intentional local run.",
);
