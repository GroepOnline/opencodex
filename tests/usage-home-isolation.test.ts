import { describe, expect, test } from "bun:test";
import {
  existsSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
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
