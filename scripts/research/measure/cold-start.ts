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
    for (;;) {
      const elapsed = performance.now() - started;
      // A non-zero exit is a crash. Exit 0 means the CLI handed off to a detached server; keep polling.
      if (child.exitCode !== null && child.exitCode !== 0) {
        let reason = "";
        try { reason = readFileSync(stderrPath, "utf8").trim().split("\n").slice(-3).join(" | "); } catch {}
        throw new Error(`server exited with code ${child.exitCode} before /healthz answered: ${reason}`);
      }
      if (elapsed > STARTUP_TIMEOUT_MS) throw new Error(`/healthz did not answer within ${STARTUP_TIMEOUT_MS} ms`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
        if (response.ok) {
          const body = (await response.json()) as Health;
          if (body.status === "ok" && body.service === "opencodex" && body.port === port) {
            const startupMs = performance.now() - started;
            servedPid = typeof body.pid === "number" && body.pid > 1 ? body.pid : null;
            return { startupMs: Math.round(startupMs * 10) / 10, rssBytes: servedPid ? rssBytesOf(servedPid) : null };
          }
        }
      } catch {
        // not listening yet
      }
      await sleep(POLL_INTERVAL_MS);
    }
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
