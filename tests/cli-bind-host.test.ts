import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("CLI startup probes the environment bind instead of a nonlocal saved hostname", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-cli-bind-"));
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved"),
  });
  const port = listener.port;
  listener.stop(true);
  const configPath = join(home, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      hostname: "192.0.2.10",
      port,
      providers: {},
      defaultProvider: "openai",
    }),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "src/cli/index.ts",
      "start",
      "--proxy-only",
      "--port",
      String(port),
    ],
    {
      cwd: join(import.meta.dir, ".."),
      env: {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        HOME: home,
        USERPROFILE: home,
        OPENCODEX_HOME: home,
        CODEX_HOME: join(home, "absent-codex"),
        OPENCODEX_BIND_HOST: "127.0.0.1",
        OCX_SERVICE: "1",
        OPENCODEX_GIT_SHA: "0123456789012345678901234567890123456789",
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  try {
    let ready = false;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
          signal: AbortSignal.timeout(250),
        });
        const health = (await response.json()) as {
          service?: string;
          pid?: number;
          port?: number;
        };
        ready =
          response.ok &&
          health.service === "opencodex" &&
          health.pid === child.pid &&
          health.port === port;
        if (ready) break;
      } catch {
        /* Wait for this child's listener. */
      }
      await Bun.sleep(25);
    }
    expect(ready).toBe(true);
    expect(JSON.parse(readFileSync(configPath, "utf8")).hostname).toBe(
      "192.0.2.10",
    );
  } finally {
    child.kill();
    await child.exited;
    rmSync(home, { recursive: true, force: true });
  }
}, 15_000);
