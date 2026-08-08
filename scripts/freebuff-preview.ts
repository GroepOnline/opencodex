import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const DEFAULT_PROXY_PORT = 10100;
const HEALTH_TIMEOUT_MS = 30_000;

function parsePort(value: string | undefined, fallback: number): number {
  const port = value && /^\d+$/.test(value) ? Number(value) : fallback;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid preview port: ${value ?? "(empty)"}`);
  }
  return port;
}

function chooseProxyPort(publicPort: number): number {
  const configured = process.env.OPENCODEX_PREVIEW_PROXY_PORT;
  if (configured) return parsePort(configured, DEFAULT_PROXY_PORT);
  return publicPort === DEFAULT_PROXY_PORT ? DEFAULT_PROXY_PORT + 1 : DEFAULT_PROXY_PORT;
}

async function waitForProxy(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`The opencodex proxy exited before becoming healthy (code ${child.exitCode}).`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(750),
      });
      if (response.ok) {
        const body = await response.json().catch(() => null) as { service?: unknown } | null;
        if (body?.service === "opencodex") return;
      }
    } catch {
      // The proxy may still be loading its startup migrations; keep polling.
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 150));
  }
  throw new Error(`The opencodex proxy did not become healthy on port ${port}.`);
}

function stopChild(child: ChildProcess | undefined): void {
  if (!child || child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
}

async function main(): Promise<void> {
  const publicPort = parsePort(process.env.PORT, 5173);
  const proxyPort = chooseProxyPort(publicPort);
  if (proxyPort === publicPort) {
    throw new Error("OPENCODEX_PREVIEW_PROXY_PORT must differ from the public PORT.");
  }

  const proxy = spawn(process.execPath, ["run", "src/cli/index.ts", "start", "--port", String(proxyPort)], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });

  let gui: ChildProcess | undefined;
  let stopping = false;
  const cleanup = () => {
    if (stopping) return;
    stopping = true;
    stopChild(gui);
    stopChild(proxy);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
  process.once("SIGHUP", cleanup);

  try {
    await waitForProxy(proxyPort, proxy);
    gui = spawn(process.execPath, ["run", "dev"], {
      cwd: resolve(root, "gui"),
      env: {
        ...process.env,
        HOST: "0.0.0.0",
        OPENCODEX_PROXY_TARGET: `http://127.0.0.1:${proxyPort}`,
        PORT: String(publicPort),
      },
      stdio: "inherit",
    });

    await new Promise<void>((resolvePromise, reject) => {
      gui?.once("error", reject);
      gui?.once("exit", code => {
        if (!stopping && code && code !== 0) reject(new Error(`The Vite dashboard exited with code ${code}.`));
        else resolvePromise();
      });
    });
  } finally {
    cleanup();
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
    process.removeListener("SIGINT", cleanup);
    process.removeListener("SIGTERM", cleanup);
    process.removeListener("SIGHUP", cleanup);
  }
}

main().catch(error => {
  console.error(`Preview failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
