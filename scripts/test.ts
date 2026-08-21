import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

/**
 * Other `bun test` runners already on this machine.
 *
 * Two full suites sharing one CPU do not fail — they crawl. A run that normally
 * finishes in about 210s took 26 minutes against a runner an earlier session had
 * left behind, and neither process said anything, so the slowdown read as a hang
 * in this suite. Bun's own timeouts cannot see the contention, so name it here.
 *
 * `pgrep` is absent on Windows and may exit non-zero for "no matches"; both cases
 * mean "nothing to warn about" rather than an error worth failing a test run over.
 */
function findCompetingTestRunners(selfPid: number): number[] {
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
    // name the wedge, and fail fast instead.
    const SUITE_KILL_AFTER_MS = 15 * 60_000;
    const child = Bun.spawn(
      [process.execPath, "test", "--isolate", ...(requestedTests.length > 0 ? requestedTests : ["./tests/"])],
      {
        env: isolated.env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    let killedForHang = false;
    const killer = setTimeout(() => {
      killedForHang = true;
      console.error(`[test] suite exceeded ${Math.round(SUITE_KILL_AFTER_MS / 60_000)}m — killing (wedged isolate suspected).`);
      child.kill(9);
    }, SUITE_KILL_AFTER_MS);
    const exitCode = await child.exited;
    clearTimeout(killer);
    if (killedForHang) process.exitCode = exitCode ?? 1;
    const elapsedMs = Date.now() - startedAt;
    const elapsedSeconds = Math.round(elapsedMs / 1000);
    if (requestedTests.length === 0 && elapsedMs > 600_000) {
      console.warn(
        `[test] the suite took ${elapsedSeconds}s; it normally runs in about 210s on an idle machine. `
        + "Check for another test runner, a busy CPU, or a test that started polling something real.",
      );
    }
    process.exitCode = exitCode ?? 1;
  } finally {
    isolated.cleanup();
  }
}
