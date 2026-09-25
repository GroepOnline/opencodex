import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PREPUSH_TIMEOUT_MS,
  prePushFailureMessage,
  shouldRunPrePush,
  skipMessage,
} from "../scripts/pre-push";

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
  expect(prePush).toContain("bun scripts/pre-push.ts");
  expect(prePush).not.toContain("bun run prepush");

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
  expect(docsContributing).toContain("when enabled");
  expect(docsContributing).toContain("40-minute limit");

  const setupHooks = readFileSync(
    join(repoRoot, "scripts/setup-hooks.ts"),
    "utf8",
  );
  expect(setupHooks).toContain("process.execPath");
  expect(setupHooks).toContain('"x", "husky"');
  expect(setupHooks).not.toContain("shell: true");
  expect(setupHooks).not.toContain('"bunx"');
});

test("pre-push keeps heavyweight checks off developer laptops by default", () => {
  expect(shouldRunPrePush({})).toBe(false);
  expect(shouldRunPrePush({ OCX_RUN_LOCAL_PREPUSH: "1" })).toBe(true);
  expect(shouldRunPrePush({ OCX_ISOLATED_BUILD: "1" })).toBe(true);
  expect(shouldRunPrePush({ CI: "true" })).toBe(true);
  expect(shouldRunPrePush({ CI: "false" })).toBe(false);
  expect(skipMessage("developer-laptop")).toContain("developer-laptop");
  expect(skipMessage("developer-laptop")).toContain(
    "GitHub-hosted CI or an authorized isolated build",
  );
  expect(PREPUSH_TIMEOUT_MS).toBe(40 * 60 * 1_000);
  expect(
    prePushFailureMessage({ code: "ETIMEDOUT", message: "timed out" }),
  ).toContain("verification timed out after 40 minutes");
  expect(
    prePushFailureMessage({ code: "ENOENT", message: "bun not found" }),
  ).toBe("pre-push: could not start verification: bun not found");

  const prePushScript = readFileSync(
    join(repoRoot, "scripts/pre-push.ts"),
    "utf8",
  );
  expect(prePushScript).toContain("timeout: PREPUSH_TIMEOUT_MS");
  expect(prePushScript).toContain("prePushFailureMessage(result.error)");
  expect(prePushScript).toContain("orphaned child processes");
});
