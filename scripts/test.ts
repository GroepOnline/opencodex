import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface IsolatedTestEnvironment {
  root: string;
  env: Record<string, string | undefined>;
  cleanup(): void;
}

export function createIsolatedTestEnvironment(
  baseEnv: Record<string, string | undefined> = process.env,
): IsolatedTestEnvironment {
  const root = mkdtempSync(join(tmpdir(), "opencodex-test-"));
  const opencodexHome = join(root, ".opencodex");
  const codexHome = join(root, ".codex");
  mkdirSync(opencodexHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });

  return {
    root,
    env: {
      ...baseEnv,
      HOME: root,
      USERPROFILE: root,
      OPENCODEX_HOME: opencodexHome,
      CODEX_HOME: codexHome,
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function buildTestSuiteArgs(
  requestedTests: string[] = [],
  env: Record<string, string | undefined> = process.env,
): string[] {
  return [
    process.execPath,
    "test",
    "--isolate",
    ...(env.OCX_TEST_COVERAGE === "1"
      ? ["--coverage", "--coverage-reporter=lcov"]
      : []),
    ...(requestedTests.length > 0 ? requestedTests : ["./tests/"]),
  ];
}

export function formatTestHangAnnotation(message: string): string {
  const escaped = message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  return `::warning title=Test suite hang::${escaped}`;
}

export function reportTestSuiteHang(
  message: string,
  env: Record<string, string | undefined> = process.env,
): void {
  console.error(`[test] ${message}`);
  if (env.GITHUB_ACTIONS) console.log(formatTestHangAnnotation(message));
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(env.GITHUB_STEP_SUMMARY, `- Test suite hang: ${message}\n`, "utf8");
    } catch {
      console.error("[test] could not append hang report to GITHUB_STEP_SUMMARY");
    }
  }
}

export async function runTestSuite(
  suiteArgs: string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  const killAfterMs = 7 * 60_000;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const startedAt = Date.now();
    const child = Bun.spawn(suiteArgs, {
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    let killedForHang = false;
    const duration = () => `${Math.round((Date.now() - startedAt) / 1000)}s`;
    const killer = setTimeout(() => {
      killedForHang = true;
      reportTestSuiteHang(
        `attempt ${attempt}/2 exceeded ${Math.round(killAfterMs / 1000)}s; killing after ${duration()} (wedged isolate suspected).`,
        env,
      );
      child.kill(9);
    }, killAfterMs);
    let exitCode: number;
    try {
      exitCode = await child.exited;
    } finally {
      clearTimeout(killer);
    }
    if (!killedForHang) {
      if (attempt === 2 && exitCode === 0) {
        reportTestSuiteHang(`attempt 2/2 passed after ${duration()}; recovered from attempt 1/2 hang-kill (exit 0).`, env);
      }
      return exitCode;
    }
    if (attempt === 2) return exitCode || 1;
    reportTestSuiteHang(`attempt 1/2 ended after ${duration()}; retrying once as attempt 2/2 after hang-kill.`, env);
  }
  return 1;
}

/**
 * Other `bun test` runners already on this machine.
 *
 * Two full suites sharing one CPU do not fail — they crawl. A run that normally
 * finishes in about 210s took 26 minutes against a runner an earlier session had
 * left behind, and neither process said anything, so the slowdown read as a hang
 * in this suite. Bun's own timeouts cannot see the contention, so name it here.
 *
 * Windows skips this advisory probe because `pgrep` and `ps` are not available.
 * A missing POSIX tool or a non-zero "no matches" result is also harmless.
 */
export function findCompetingTestRunners(selfPid: number): number[] {
  if (process.platform === "win32") return [];
  try {
    const found = Bun.spawnSync(["pgrep", "-f", "bun.*test --isolate"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (!found.success) return [];
    const candidates = new TextDecoder().decode(found.stdout)
      .split("\n")
      .map(line => Number.parseInt(line.trim(), 10))
      .filter(pid => Number.isInteger(pid) && pid > 0 && pid !== selfPid);
    return keepBunExecutables(candidates);
  } catch {
    return [];
  }
}

/**
 * `pgrep -f` matches the whole command line, so a shell, `make` target, or CI wrapper
 * that merely mentions `bun test --isolate` looks like a second runner. Only a process
 * whose executable really is Bun can contend for the CPU the way the warning claims,
 * so drop everything else rather than blaming an innocent parent shell.
 */
function keepBunExecutables(pids: number[]): number[] {
  if (pids.length === 0) return [];
  const listed = Bun.spawnSync(["ps", "-o", "pid=,comm=", "-p", pids.join(",")], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (!listed.success) return [];
  const bunPids = new Set<number>();
  for (const line of new TextDecoder().decode(listed.stdout).split("\n")) {
    const match = /^\s*(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1]!, 10);
    const executable = match[2]!.split(/[/\\]/).pop() ?? "";
    if (/^bun(\b|[-_.])/.test(executable)) bunPids.add(pid);
  }
  return pids.filter(pid => bunPids.has(pid));
}

if (import.meta.main) {
  const isolated = createIsolatedTestEnvironment();
  try {
    const requestedTests = process.argv.slice(2);
    const competing = findCompetingTestRunners(process.pid);
    if (competing.length > 0) {
      console.warn(
        `[test] ${competing.length} other bun test runner(s) are already running (pid ${competing.join(", ")}). `
        + "They share this machine's CPU, so this run will be much slower than usual and can look hung. "
        + "Stop them first if that is not what you meant.",
      );
    }
    const startedAt = Date.now();
    // Async spawn with a hard kill boundary, not spawnSync: a wedged test isolate (e.g. a
    // sync wait inside a timed test under CI load) would otherwise sit in total silence until
    // an external job timeout — burning the whole 20-minute CI budget on a hang. Kill here,
    // name the wedge, and retry ONCE: two observed wedges (codex-shim lock handshake,
    // live-checkout git probe) were load-ordering flukes, not deterministic failures, and the
    // retry keeps one wedge from failing an otherwise-green 6600-test run.
    const suiteArgs = buildTestSuiteArgs(requestedTests, isolated.env);
    const exitCode = await runTestSuite(suiteArgs, isolated.env);
    const elapsedMs = Date.now() - startedAt;
    const elapsedSeconds = Math.round(elapsedMs / 1000);
    if (requestedTests.length === 0 && elapsedMs > 600_000) {
      console.warn(
        `[test] the suite took ${elapsedSeconds}s; it normally runs in about 210s on an idle machine. `
        + "Check for another test runner, a busy CPU, or a test that started polling something real.",
      );
    }
    process.exitCode = exitCode;
  } finally {
    isolated.cleanup();
  }
}
