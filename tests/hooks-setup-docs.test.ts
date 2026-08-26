import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..");

test("husky hook wiring is committed and documented", () => {
  const pkg = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  ) as {
    scripts: Record<string, string>;
  };
  expect(pkg.scripts.prepare).toBe("husky || true");

  const preCommit = readFileSync(join(repoRoot, ".husky/pre-commit"), "utf8");
  expect(preCommit).toContain("bunx lint-staged");
  expect(preCommit).not.toContain("bun run typecheck");
  expect(preCommit).not.toContain("bun run test");

  const prePush = readFileSync(join(repoRoot, ".husky/pre-push"), "utf8");
  expect(prePush).toContain("bun run prepush");

  const contributing = readFileSync(join(repoRoot, "CONTRIBUTING.md"), "utf8");
  expect(contributing).toContain("Husky");
  expect(contributing).toContain("lint-staged");
  expect(contributing).toContain("git commit --no-verify");

  const docsContributing = readFileSync(
    join(repoRoot, "docs-site/src/content/docs/contributing.md"),
    "utf8",
  );
  expect(docsContributing).toContain("Husky");
  expect(docsContributing).toContain("lint-staged");

  const setupHooks = readFileSync(
    join(repoRoot, "scripts/setup-hooks.ts"),
    "utf8",
  );
  expect(setupHooks).toContain("process.execPath");
  expect(setupHooks).toContain('"x", "husky"');
  expect(setupHooks).not.toContain("shell: true");
  expect(setupHooks).not.toContain('"bunx"');
});
