import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_TEST_KILL_AFTER_MS,
  buildTestSuiteArgs,
  createIsolatedTestEnvironment,
  findCompetingTestRunners,
  formatTestHangAnnotation,
  reportTestSuiteHang,
  resolveTestKillAfterMs,
  runTestSuite,
} from "../scripts/test";

describe("test runner isolation", () => {
  test("redirects user homes to a disposable root", () => {
    const isolated = createIsolatedTestEnvironment({ PATH: "/test/bin", HOME: "/real/home" });
    try {
      expect(isolated.env).toMatchObject({
        PATH: "/test/bin",
        HOME: isolated.root,
        USERPROFILE: isolated.root,
        OPENCODEX_HOME: join(isolated.root, ".opencodex"),
        CODEX_HOME: join(isolated.root, ".codex"),
      });
      expect(existsSync(isolated.env.OPENCODEX_HOME!)).toBe(true);
      expect(existsSync(isolated.env.CODEX_HOME!)).toBe(true);
    } finally {
      isolated.cleanup();
    }
    expect(existsSync(isolated.root)).toBe(false);
  });
});

describe("test runner arguments", () => {
  test.each([undefined, "", "0", "true"])("coverage is opt-in (%j)", (value) => {
    expect(buildTestSuiteArgs([], { OCX_TEST_COVERAGE: value })).toEqual([
      process.execPath, "test", "--isolate", "./tests/",
    ]);
  });

  test("coverage adds the lcov reporter without changing test selection", () => {
    const coverage = { OCX_TEST_COVERAGE: "1" };
    expect(buildTestSuiteArgs([], coverage)).toEqual([
      process.execPath, "test", "--isolate", "--coverage", "--coverage-reporter=lcov", "./tests/",
    ]);
    expect(buildTestSuiteArgs(["./tests/test-runner.test.ts"], coverage)).toEqual([
      process.execPath, "test", "--isolate", "--coverage", "--coverage-reporter=lcov", "./tests/test-runner.test.ts",
    ]);
    expect(buildTestSuiteArgs(["./tests/test-runner.test.ts"], {})).toEqual([
      process.execPath, "test", "--isolate", "./tests/test-runner.test.ts",
    ]);
  });
});

describe("test runner hang boundary", () => {
  test("defaults to the 7-minute wedge boundary", () => {
    expect(resolveTestKillAfterMs(undefined)).toBe(DEFAULT_TEST_KILL_AFTER_MS);
    expect(resolveTestKillAfterMs("")).toBe(DEFAULT_TEST_KILL_AFTER_MS);
    expect(resolveTestKillAfterMs("   ")).toBe(DEFAULT_TEST_KILL_AFTER_MS);
  });

  test("honors an explicit OCX_TEST_KILL_AFTER_MS override", () => {
    expect(resolveTestKillAfterMs("60000")).toBe(60_000);
    expect(resolveTestKillAfterMs("900000")).toBe(900_000);
    expect(resolveTestKillAfterMs("3600000")).toBe(3_600_000);
  });

  test("rejects values that would disable the wedge protection", () => {
    expect(() => resolveTestKillAfterMs("59999")).toThrow(/between 60000 and 3600000/);
    expect(() => resolveTestKillAfterMs("3600001")).toThrow(/between 60000 and 3600000/);
    expect(() => resolveTestKillAfterMs("not-a-number")).toThrow(/between 60000 and 3600000/);
    expect(() => resolveTestKillAfterMs("true")).toThrow(/between 60000 and 3600000/);
  });
});

describe("test runner hang reporting", () => {
  test("formats a titled Actions warning and escapes command data", () => {
    expect(formatTestHangAnnotation("attempt 1/2 killed after 420s")).toBe(
      "::warning title=Test suite hang::attempt 1/2 killed after 420s",
    );
    expect(formatTestHangAnnotation("100%: hung, retry\r\n::error::not a command")).toBe(
      "::warning title=Test suite hang::100%25: hung, retry%0D%0A::error::not a command",
    );
  });

  test("appends summaries independently of Actions and preserves existing content", () => {
    const isolated = createIsolatedTestEnvironment({});
    const summary = join(isolated.root, "summary.md");
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const logs = spyOn(console, "log").mockImplementation(() => {});
    try {
      writeFileSync(summary, "Existing summary\n");
      const message = "attempt 1/2 killed after 420s";
      reportTestSuiteHang(message, { GITHUB_STEP_SUMMARY: summary });
      expect(logs).not.toHaveBeenCalled();
      reportTestSuiteHang(message, { GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summary });
      expect(logs.mock.calls).toEqual([[formatTestHangAnnotation(message)]]);
      expect(readFileSync(summary, "utf8")).toBe(
        `Existing summary\n- Test suite hang: ${message}\n- Test suite hang: ${message}\n`,
      );
      reportTestSuiteHang(message, {});
      expect(logs).toHaveBeenCalledTimes(1);
      expect(errors).toHaveBeenCalledTimes(3);
    } finally {
      logs.mockRestore();
      errors.mockRestore();
      isolated.cleanup();
    }
  });

  test("a summary write failure cannot prevent the hang kill or change exit policy", () => {
    const isolated = createIsolatedTestEnvironment({});
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => reportTestSuiteHang("attempt 1/2 killed after 420s", {
        GITHUB_STEP_SUMMARY: isolated.root,
      })).not.toThrow();
      expect(errors.mock.calls[1]).toEqual([
        "[test] could not append hang report to GITHUB_STEP_SUMMARY",
      ]);
    } finally {
      errors.mockRestore();
      isolated.cleanup();
    }
  });

  test.each([
    { hangs: [true, false], codes: [137, 0], expected: 0, reports: 3 },
    { hangs: [true, false], codes: [137, 1], expected: 1, reports: 2 },
    { hangs: [true, true], codes: [137, 0], expected: 1, reports: 3 },
    { hangs: [false], codes: [1], expected: 1, reports: 0 },
    { hangs: [false], codes: [0], expected: 0, reports: 0 },
  ])("keeps the bounded retry policy visible (%j)", async ({ hangs, codes, expected, reports }) => {
    let clock = 0;
    let timeout: () => void = () => {};
    const now = spyOn(Date, "now").mockImplementation(() => clock);
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      timeout = callback;
      return 0;
    }) as unknown as typeof setTimeout);
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const logs = spyOn(console, "log").mockImplementation(() => {});
    const kills: number[] = [];
    let attempts = 0;
    const spawn = spyOn(Bun, "spawn").mockImplementation((() => {
      const index = attempts++;
      return {
        kill(signal: number) { kills.push(signal); },
        get exited() {
          clock += hangs[index] ? 420_000 : 2_000;
          if (hangs[index]) timeout();
          return Promise.resolve(codes[index]!);
        },
      };
    }) as unknown as typeof Bun.spawn);
    try {
      const args = buildTestSuiteArgs([], {});
      const env = { GITHUB_ACTIONS: "true" };
      expect(await runTestSuite(args, env)).toBe(expected);
      expect(attempts).toBe(codes.length);
      expect(kills).toEqual(hangs.filter(Boolean).map(() => 9));
      expect(timer.mock.calls.every(call => call[1] === 420_000)).toBe(true);
      expect(clear).toHaveBeenCalledTimes(attempts);
      expect(spawn.mock.calls[0]).toEqual([args, {
        env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
      }]);
      expect(logs).toHaveBeenCalledTimes(reports);
      if (hangs[0]) {
        expect(logs.mock.calls[0]).toEqual([formatTestHangAnnotation(
          "attempt 1/2 exceeded 420s; killing after 420s (wedged isolate suspected).",
        )]);
        expect(logs.mock.calls[1]).toEqual([formatTestHangAnnotation(
          "attempt 1/2 ended after 420s; retrying once as attempt 2/2 after hang-kill.",
        )]);
        if (!hangs[1] && expected === 0) {
          expect(logs.mock.calls[2]).toEqual([formatTestHangAnnotation(
            "attempt 2/2 passed after 2s; recovered from attempt 1/2 hang-kill (exit 0).",
          )]);
        }
      }
    } finally {
      spawn.mockRestore();
      logs.mockRestore();
      errors.mockRestore();
      clear.mockRestore();
      timer.mockRestore();
      now.mockRestore();
    }
  });
});

test.skipIf(process.platform !== "win32")("Windows skips POSIX competing-runner probes", () => {
  const spawn = spyOn(Bun, "spawnSync").mockImplementation(() => {
    throw new Error("POSIX probe must not run on Windows");
  });
  try {
    expect(findCompetingTestRunners(process.pid)).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    spawn.mockRestore();
  }
});
