#!/usr/bin/env bun
/**
 * Cold-start measurement: spawn `start --proxy-only` against an isolated HOME and time how long it takes
 * until GET /healthz identifies an opencodex process. Prints one JSON object:
 *   { value: startupMs, details: { startupMs, rssBytes, tarballBytes } }
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createIsolatedTestEnvironment } from "../../test";
import { REPO_ROOT } from "../lib";

const STARTUP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 10;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

function rssBytesOf(pid: number): number | null {
  try {
    if (process.platform === "linux") {
      const match = /VmRSS:\s+(\d+)\s+kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
      return match ? Number(match[1]) * 1024 : null;
    }
    if (process.platform === "win32") return null;
    const ps = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const kb = Number(new TextDecoder().decode(ps.stdout).trim());
    return ps.success && Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
  } catch {
    return null;
  }
}

function tarballBytes(): number | null {
  try {
    const result = Bun.spawnSync(["npm", "pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (!result.success) return null;
    const parsed = JSON.parse(new TextDecoder().decode(result.stdout)) as { size?: number }[];
    const size = parsed[0]?.size;
    return typeof size === "number" ? size : null;
  } catch {
    return null;
  }
}

interface Health {
  status?: string;
  service?: string;
  pid?: number;
  port?: number;
}

async function probeHealthz(port: number): Promise<{ pid: number | null } | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
    if (!response.ok) return null;
    const body = (await response.json()) as Health;
    if (body.status !== "ok" || body.service !== "opencodex" || body.port !== port) return null;
    return { pid: typeof body.pid === "number" && body.pid > 1 ? body.pid : null };
  } catch {
    return null;
  }
}

function startupError(stderrPath: string, exitCode: number): Error {
  let reason = "";
  try {
    reason = readFileSync(stderrPath, "utf8").trim().split("\n").slice(-3).join(" | ");
  } catch {
    // The stderr file might not exist yet after a fast crash.
  }
  return new Error(`server exited with code ${exitCode} before /healthz answered: ${reason}`);
}

async function waitForHealthyServer(
  port: number,
  started: number,
  stderrPath: string,
  exitCode: () => number | null,
): Promise<{ startupMs: number; servedPid: number | null }> {
  for (;;) {
    const elapsed = performance.now() - started;
    const code = exitCode();
    // Exit 0 may mean that the CLI handed off to a detached server.
    if (code !== null && code !== 0) throw startupError(stderrPath, code);
    if (elapsed > STARTUP_TIMEOUT_MS) throw new Error(`/healthz did not answer within ${STARTUP_TIMEOUT_MS} ms`);
    const healthy = await probeHealthz(port);
    if (healthy) {
      return { startupMs: Math.round((performance.now() - started) * 10) / 10, servedPid: healthy.pid };
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function measureStartup(): Promise<{ startupMs: number; rssBytes: number | null }> {
  const isolated = createIsolatedTestEnvironment();
  const port = await freePort();
  const stderrPath = join(isolated.root, "start.stderr.log");
  const started = performance.now();
  const child = Bun.spawn(
    [process.execPath, "src/cli/index.ts", "start", "--port", String(port), "--proxy-only"],
    { cwd: REPO_ROOT, env: isolated.env, stdin: "ignore", stdout: "ignore", stderr: Bun.file(stderrPath) },
  );
  let servedPid: number | null = null;
  try {
    const ready = await waitForHealthyServer(port, started, stderrPath, () => child.exitCode);
    servedPid = ready.servedPid;
    return { startupMs: ready.startupMs, rssBytes: servedPid ? rssBytesOf(servedPid) : null };
  } finally {
    child.kill();
    if (servedPid !== null && servedPid !== child.pid) {
      try { process.kill(servedPid); } catch {}
    }
    await Promise.race([child.exited, sleep(2000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    isolated.cleanup();
  }
}

const { startupMs, rssBytes } = await measureStartup();
process.stdout.write(`${JSON.stringify({ value: startupMs, details: { startupMs, rssBytes, tarballBytes: tarballBytes() } })}\n`);
process.exit(0);
