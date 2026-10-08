import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
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
