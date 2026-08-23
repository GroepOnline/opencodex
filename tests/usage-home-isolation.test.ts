import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
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
  test("preload isolates OPENCODEX_HOME away from the live user home", () => {
    expect(process.env.OPENCODEX_TEST_HOME).toBeTruthy();
    expect(process.env.OPENCODEX_REAL_HOME).toBeTruthy();
    const isolated = resolve(join(process.env.OPENCODEX_TEST_HOME!, "usage.jsonl"));
    expect(isolated).not.toBe(liveUsagePath());
    expect(isolated.startsWith(resolve(tmpdir()) + "/")).toBe(true);
  });

  test("guard refuses the live usage.jsonl path", () => {
    expect(() => assertUsageLogPathIsolatedForTests(liveUsagePath()))
      .toThrow(/escaped test isolation/);
  });

  test("appendUsageEntry refuses a write aimed at the live home", () => {
    const before = liveMtime();
    const savedHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = join(process.env.OPENCODEX_REAL_HOME!, ".opencodex");
    try {
      expect(() => appendUsageEntry({
        requestId: "ocx-isolation-probe",
        timestamp: 1,
        provider: "no-such-provider",
        model: "no-such-model",
        status: 200,
        durationMs: 1,
        usageStatus: "unreported",
      })).toThrow(/escaped test isolation/);
    } finally {
      if (savedHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = savedHome;
    }
    expect(liveMtime()).toBe(before);
    expect(resolve(usageLogPath())).not.toBe(liveUsagePath());
  });
});
