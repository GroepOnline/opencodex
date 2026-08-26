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

// shell: true so Windows resolves the `bunx` shim (.cmd/.exe) via PATH;
// execFileSync alone can't launch a .cmd without a shell.
execFileSync("bunx", ["husky"], { cwd: repoRoot, stdio: "inherit", shell: true });
console.log("Husky hooks installed (.husky/pre-commit and .husky/pre-push).");
console.log(
  "Skip in an emergency with: git commit --no-verify / git push --no-verify",
);
