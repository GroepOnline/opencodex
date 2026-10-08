import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { assertUsageLogPathIsolatedForTests } from "../src/usage/isolation";
import { appendUsageEntry, usageLogPath } from "../src/usage/log";

function liveUsagePath(): string {
  const realHome = process.env.OPENCODEX_REAL_HOME;
  if (!realHome) throw new Error("preload did not capture OPENCODEX_REAL_HOME");
  return resolve(join(realHome, ".opencodex", "usage.jsonl"));
}

function liveMtime(): number | null {
  const live = liveUsagePath();
  return existsSync(live) ? statSync(live).mtimeMs : null;
}

describe("usage.jsonl test isolation", () => {
  describe("synthetic home boundaries", () => {
    const envKeys = [
      "OPENCODEX_HOME",
      "OPENCODEX_TEST_HOME",
      "OPENCODEX_REAL_HOME",
      "OPENCODEX_REAL_CONFIG_DIR",
      "BUN_TEST",
    ] as const;
    let previous: Array<string | undefined>;
    let root: string;

    beforeEach(() => {
      previous = envKeys.map((key) => process.env[key]);
      root = mkdtempSync(join(tmpdir(), "ocx-isolation-boundaries-"));
      process.env.OPENCODEX_TEST_HOME = join(root, "test-home");
      process.env.OPENCODEX_REAL_HOME = join(root, "operator");
      process.env.OPENCODEX_REAL_CONFIG_DIR = join(root, "configured");
      delete process.env.BUN_TEST;
    });

    afterEach(() => {
      envKeys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
      rmSync(root, { recursive: true, force: true });
    });

    test("allows missing fixture directories and similarly prefixed sibling homes", () => {
      for (const path of [
        join(root, "fixture", "nested", "usage.jsonl"),
        join(root, "configured-copy", "usage.jsonl"),
        join(root, "operator", ".opencodex-copy", "usage.jsonl"),
      ]) {
        expect(() => assertUsageLogPathIsolatedForTests(path)).not.toThrow();
        expect(existsSync(path)).toBe(false);
      }
    });

    test("rejects a path sharing only the temp directory's string prefix", () => {
      const outside = resolve(
        tmpdir(),
        "..",
        `${basename(tmpdir())}-ocx-outside`,
        "usage.jsonl",
      );
      expect(() => assertUsageLogPathIsolatedForTests(outside)).toThrow(
        /not under the system temp/,
      );
    });

    test("BUN_TEST alone activates the guard", () => {
      delete process.env.OPENCODEX_TEST_HOME;
      process.env.BUN_TEST = "1";
      expect(() =>
        assertUsageLogPathIsolatedForTests(
          join(root, "configured", "usage.jsonl"),
        ),
      ).toThrow(/original configured/);
    });

    test("does not restrict normal runtime paths without a test marker", () => {
      process.env.OPENCODEX_TEST_HOME = " \t ";
      process.env.BUN_TEST = "0";
      expect(() =>
        assertUsageLogPathIsolatedForTests(
          join(root, "configured", "usage.jsonl"),
        ),
      ).not.toThrow();
    });

    test("rejects nested original-home writes before creating any directories", () => {
      const configured = join(root, "configured");
      process.env.OPENCODEX_HOME = join(configured, "nested");
      expect(() =>
        appendUsageEntry({
          requestId: "blocked-before-mkdir",
          timestamp: 1,
          provider: "fixture",
          model: "fixture",
          status: 200,
          durationMs: 1,
          usageStatus: "unreported",
        }),
      ).toThrow(/original configured/);
      expect(existsSync(configured)).toBe(false);
    });

    test("rejects an alias of the original configured home", () => {
      const target = join(root, "configured");
      const alias = join(root, "alias");
      mkdirSync(target);
      symlinkSync(
        target,
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(() =>
        assertUsageLogPathIsolatedForTests(
          join(alias, "missing", "usage.jsonl"),
        ),
      ).toThrow(/original configured/);
    });

    test.skipIf(process.platform === "win32")(
      "follows relative symlink chains to a missing live log",
      () => {
        const live = join(root, "operator", ".opencodex");
        mkdirSync(live, { recursive: true });
        symlinkSync(
          join("operator", ".opencodex", "usage.jsonl"),
          join(root, "hop"),
        );
        symlinkSync("hop", join(root, "usage.jsonl"));
        expect(() =>
          assertUsageLogPathIsolatedForTests(join(root, "usage.jsonl")),
        ).toThrow(/live OPENCODEX/);
        expect(existsSync(join(live, "usage.jsonl"))).toBe(false);
      },
    );
  });

  test("preload retains the original configured home and reuses its own home on repeated imports", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-preload-reuse-"));
    const configured = join(root, "original");
    const preload = join(import.meta.dir, "preload-opencodex-home.ts");
    try {
      const child = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `
        delete process.env.OPENCODEX_REAL_CONFIG_DIR;
        process.env.OPENCODEX_HOME = ${JSON.stringify(configured)};
        require(${JSON.stringify(preload)});
        const first = process.env.OPENCODEX_HOME;
        process.env.OPENCODEX_HOME = ${JSON.stringify(join(root, "changed"))};
        delete require.cache[require.resolve(${JSON.stringify(preload)})];
        require(${JSON.stringify(preload)});
        process.stdout.write(JSON.stringify({
          first, second: process.env.OPENCODEX_HOME,
          original: process.env.OPENCODEX_REAL_CONFIG_DIR,
          owner: process.env.OPENCODEX_TEST_OWNER_PID, pid: process.pid,
        }));
      `,
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 5_000 },
      );
      expect(child.exitCode).toBe(0);
      const result = JSON.parse(new TextDecoder().decode(child.stdout));
      expect(result.original).toBe(resolve(configured));
      expect(result.first).not.toBe(configured);
      expect(result.second).toBe(result.first);
      expect(result.owner).toBe(String(result.pid));
      expect(existsSync(result.first)).toBe(false);
      expect(existsSync(configured)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("guard rejects the original configured home even below tmpdir", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-original-home-"));
    const previous = process.env.OPENCODEX_REAL_CONFIG_DIR;
    process.env.OPENCODEX_REAL_CONFIG_DIR = home;
    try {
      expect(() =>
        assertUsageLogPathIsolatedForTests(join(home, "usage.jsonl")),
      ).toThrow(/original configured/);
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_REAL_CONFIG_DIR;
      else process.env.OPENCODEX_REAL_CONFIG_DIR = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("guard follows a directory link to a live home before the log exists", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-linked-home-"));
    const live = join(root, ".opencodex");
    const link = join(root, "fixture-link");
    const previous = process.env.OPENCODEX_REAL_HOME;
    mkdirSync(live);
    symlinkSync(live, link, process.platform === "win32" ? "junction" : "dir");
    process.env.OPENCODEX_REAL_HOME = root;
    try {
      expect(() =>
        assertUsageLogPathIsolatedForTests(join(link, "usage.jsonl")),
      ).toThrow(/live OPENCODEX/);
      expect(existsSync(join(live, "usage.jsonl"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_REAL_HOME;
      else process.env.OPENCODEX_REAL_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    "guard follows a dangling file symlink to the live log",
    () => {
      const root = mkdtempSync(join(tmpdir(), "ocx-linked-log-"));
      const live = join(root, ".opencodex");
      const link = join(root, "usage.jsonl");
      const previous = process.env.OPENCODEX_REAL_HOME;
      mkdirSync(live);
      symlinkSync(join(live, "usage.jsonl"), link);
      process.env.OPENCODEX_REAL_HOME = root;
      try {
        expect(() => assertUsageLogPathIsolatedForTests(link)).toThrow(
          /live OPENCODEX/,
        );
        expect(existsSync(join(live, "usage.jsonl"))).toBe(false);
      } finally {
        if (previous === undefined) delete process.env.OPENCODEX_REAL_HOME;
        else process.env.OPENCODEX_REAL_HOME = previous;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test("a child test process owns and cleans up its temporary home", () => {
    const child = Bun.spawnSync(
      [
        process.execPath,
        "--preload",
        "./tests/preload-opencodex-home.ts",
        "-e",
        "process.stdout.write(JSON.stringify({ home: process.env.OPENCODEX_TEST_HOME, owner: process.env.OPENCODEX_TEST_OWNER_PID, pid: process.pid }))",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(child.exitCode).toBe(0);
    const result = JSON.parse(new TextDecoder().decode(child.stdout)) as {
      home: string;
      owner: string;
      pid: number;
    };
    expect(result.owner).toBe(String(result.pid));
    expect(result.home).not.toBe(process.env.OPENCODEX_TEST_HOME);
    expect(existsSync(result.home)).toBe(false);
  });

  test("preload isolates OPENCODEX_HOME away from the live user home", () => {
    expect(process.env.OPENCODEX_TEST_HOME).toBeTruthy();
    expect(process.env.OPENCODEX_REAL_HOME).toBeTruthy();
    const isolated = resolve(
      join(process.env.OPENCODEX_TEST_HOME!, "usage.jsonl"),
    );
    expect(isolated).not.toBe(liveUsagePath());
    expect(isolated.startsWith(resolve(tmpdir()) + sep)).toBe(true);
  });

  test("guard refuses the live usage.jsonl path", () => {
    expect(() => assertUsageLogPathIsolatedForTests(liveUsagePath())).toThrow(
      /escaped test isolation/,
    );
  });

  test("appendUsageEntry refuses a write aimed at the live home", () => {
    const before = liveMtime();
    const savedHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = join(
      process.env.OPENCODEX_REAL_HOME!,
      ".opencodex",
    );
    try {
      expect(() =>
        appendUsageEntry({
          requestId: "ocx-isolation-probe",
          timestamp: 1,
          provider: "no-such-provider",
          model: "no-such-model",
          status: 200,
          durationMs: 1,
          usageStatus: "unreported",
        }),
      ).toThrow(/escaped test isolation/);
    } finally {
      if (savedHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = savedHome;
    }
    expect(liveMtime()).toBe(before);
    expect(resolve(usageLogPath())).not.toBe(liveUsagePath());
  });
});
