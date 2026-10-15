import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * Local agent/session state must never reach a commit.
 *
 * `.gitignore` alone does not enforce this: `git add -f` overrides it silently,
 * and once a path is tracked the ignore rule stops applying to it entirely. The
 * `.codexclaw/` goalplans and ledgers were committed exactly that way and rode
 * along into `main` and `preview` before anyone noticed.
 *
 * This test closes that gap by asserting against the real index instead of the
 * ignore file, so a forced add fails CI on the commit that introduces it.
 */
const FORBIDDEN_TRACKED_DIRS = [
  ".codexclaw",
  ".omo",
  ".claude",
  "node_modules",
  ".tmp",
];

/**
 * Serena project configuration is deliberate shared repository config (PR
 * #365; the same two files are tracked on Commander main), not local
 * agent/session state. Only these two exact paths are permitted; every other
 * `.serena/` path — caches, memories, `project.local.yml`, session state —
 * stays forbidden by the `.serena` segment check below.
 */
const SERENA_CONFIG_ALLOWLIST = new Set([
  ".serena/.gitignore",
  ".serena/project.yml",
]);

const FORBIDDEN_TRACKED_FILENAMES = [".DS_Store", "Thumbs.db"];

function trackedFiles(): string[] {
  const result = Bun.spawnSync(["git", "ls-files"], { cwd: repoRoot });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ls-files failed: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function trackedEntries(): { mode: string; path: string }[] {
  const result = Bun.spawnSync(["git", "ls-files", "-s"], { cwd: repoRoot });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ls-files -s failed: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split("\t");
      return { mode: meta?.split(" ")[0] ?? "", path: path ?? "" };
    });
}

describe("repository hygiene", () => {
  test("no local agent or session state is tracked", () => {
    const offenders = trackedFiles().filter(
      (path) =>
        path
          .split("/")
          .some((segment) => FORBIDDEN_TRACKED_DIRS.includes(segment)) ||
        (path.split("/").includes(".serena") &&
          !SERENA_CONFIG_ALLOWLIST.has(path)),
    );

    expect(offenders).toEqual([]);
  });

  test("only the two deliberate Serena project-config files may be tracked", () => {
    const serenaTracked = trackedFiles().filter((path) =>
      path.startsWith(".serena/"),
    );

    for (const path of serenaTracked) {
      expect(SERENA_CONFIG_ALLOWLIST.has(path)).toBe(true);
    }
  });

  test("no OS metadata files are tracked", () => {
    const offenders = trackedFiles().filter((path) =>
      FORBIDDEN_TRACKED_FILENAMES.includes(path.split("/").pop() ?? ""),
    );

    expect(offenders).toEqual([]);
  });

  test("gitignore still declares the agent-state directories", async () => {
    const ignore = await Bun.file(
      new URL("../.gitignore", import.meta.url),
    ).text();

    // `.serena/` stays ignored so untracked Serena caches/state never show up
    // as candidates; the two allowlisted config files are already tracked, so
    // the ignore rule does not apply to them.
    for (const dir of [...FORBIDDEN_TRACKED_DIRS, ".serena"]) {
      expect(ignore).toContain(`${dir}/`);
    }
  });
});

/**
 * `devlog/` is a private submodule, and public CI must never need it.
 *
 * The failure mode this locks down is specific and has already happened twice:
 * a `160000` gitlink lands in the index for a path no workflow initializes, and
 * `actions/checkout` fails for every contributor. Keeping the pointer loose —
 * one gitlink, `ignore = dirty`, `update = none`, no `submodules:` in any
 * workflow — is what makes an inaccessible private repository harmless.
 */
describe("devlog submodule stays loose", () => {
  test("devlog is the only gitlink, and no devlog file is tracked here", () => {
    const gitlinks = trackedEntries().filter(
      (entry) => entry.mode === "160000",
    );

    expect(gitlinks.map((entry) => entry.path)).toEqual(["devlog"]);

    const devlogFiles = trackedFiles().filter((path) =>
      path.startsWith("devlog/"),
    );
    expect(devlogFiles).toEqual([]);
  });

  test("gitmodules keeps the submodule non-blocking", async () => {
    const gitmodules = await Bun.file(
      new URL("../.gitmodules", import.meta.url),
    ).text();

    expect(gitmodules).toContain('[submodule "devlog"]');
    expect(gitmodules).toContain("ignore = dirty");
    expect(gitmodules).toContain("update = none");
  });

  test("no workflow checks out submodules", async () => {
    const listing = Bun.spawnSync(["git", "ls-files", ".github/workflows"], {
      cwd: repoRoot,
    });
    const workflows = new TextDecoder()
      .decode(listing.stdout)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    expect(workflows.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const workflow of workflows) {
      const text = await Bun.file(
        new URL(`../${workflow}`, import.meta.url),
      ).text();
      // `submodules: false` is fine; anything that opts in is not.
      if (/submodules:\s*(true|recursive)/.test(text)) offenders.push(workflow);
      if (/git submodule update[^\n]*devlog/.test(text))
        offenders.push(workflow);
    }

    expect(offenders).toEqual([]);
  });
});
