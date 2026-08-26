import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig } from "../src/config";
import {
  assertServerAuthConfig,
  effectiveBindHostname,
  hasValidApiAuth,
  isApiAuthRequired,
  startServer,
} from "../src/server";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const healthScript = join(repoRoot, "scripts/container-health.ts");
const entrypoint = join(repoRoot, "scripts/container-entrypoint.sh");
const previousHome = process.env.OPENCODEX_HOME;
const previousToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousBindHost = process.env.OPENCODEX_BIND_HOST;

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousToken;
  if (previousBindHost === undefined) delete process.env.OPENCODEX_BIND_HOST;
  else process.env.OPENCODEX_BIND_HOST = previousBindHost;
});

async function runHealth(port: number) {
  const proc = Bun.spawn([process.execPath, healthScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OPENCODEX_HEALTH_HOST: "127.0.0.1",
      OPENCODEX_HEALTH_PORT: String(port),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stderr };
}

describe("container image", () => {
  test("Dockerfile and compose pin health probe, entrypoint, and file-backed token", async () => {
    const dockerfile = await Bun.file(join(repoRoot, "Dockerfile")).text();
    const compose = await Bun.file(
      join(repoRoot, "deploy/container/compose.example.yml"),
    ).text();
    expect(dockerfile).toContain(
      'CMD ["bun", "run", "scripts/container-health.ts"]',
    );
    expect(dockerfile).toContain(
      'ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/container-entrypoint.sh"]',
    );
    expect(compose).toContain("OPENCODEX_IMAGE:?pin an immutable image digest");
    expect(compose).toContain(
      "OPENCODEX_API_AUTH_TOKEN_FILE: /run/secrets/opencodex_api_token",
    );
    expect(compose).not.toMatch(/^(\s*)OPENCODEX_API_AUTH_TOKEN:/m);
  });

  test("health probe accepts identity-ok /healthz and rejects mismatch", async () => {
    const ok = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        Response.json({
          status: "ok",
          service: "opencodex",
          pid: 1,
          port: 10100,
          gitSha: "abc123",
        }),
    });
    try {
      expect((await runHealth(ok.port)).exitCode).toBe(0);
    } finally {
      ok.stop(true);
    }

    const bad = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        Response.json({
          status: "ok",
          service: "not-opencodex",
          pid: 1,
          port: 10100,
        }),
    });
    try {
      const result = await runHealth(bad.port);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("health identity mismatch");
    } finally {
      bad.stop(true);
    }
  });

  test("health probe rejects missing, empty, or non-string gitSha", async () => {
    for (const gitSha of [undefined, "", 12] as const) {
      const body =
        gitSha === undefined
          ? { status: "ok", service: "opencodex", pid: 1, port: 10100 }
          : { status: "ok", service: "opencodex", pid: 1, port: 10100, gitSha };
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => Response.json(body),
      });
      try {
        const result = await runHealth(server.port);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("health gitSha missing");
      } finally {
        server.stop(true);
      }
    }
  });

  test("OPENCODEX_BIND_HOST=0.0.0.0 without a token fails closed like a bare docker run", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-container-bind-"));
    try {
      process.env.OPENCODEX_HOME = dir;
      delete process.env.OPENCODEX_API_AUTH_TOKEN;
      process.env.OPENCODEX_BIND_HOST = "0.0.0.0";
      const loaded = loadConfig();
      expect(loaded.hostname).toBeUndefined();
      expect(effectiveBindHostname(loaded)).toBe("0.0.0.0");
      expect(isApiAuthRequired(loaded)).toBe(true);
      expect(() => assertServerAuthConfig(loaded)).toThrow(
        "OPENCODEX_API_AUTH_TOKEN",
      );
      expect(() => startServer(0)).toThrow("OPENCODEX_API_AUTH_TOKEN");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("OPENCODEX_BIND_HOST=0.0.0.0 with a token requires it on data-plane requests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-container-bind-"));
    try {
      process.env.OPENCODEX_HOME = dir;
      process.env.OPENCODEX_API_AUTH_TOKEN = "container-secret";
      process.env.OPENCODEX_BIND_HOST = "0.0.0.0";
      const loaded = loadConfig();
      expect(isApiAuthRequired(loaded)).toBe(true);
      expect(
        hasValidApiAuth(new Request("http://127.0.0.1/v1/models"), loaded),
      ).toBe(false);
      expect(
        hasValidApiAuth(
          new Request("http://127.0.0.1/v1/models", {
            headers: { "x-opencodex-api-key": "container-secret" },
          }),
          loaded,
        ),
      ).toBe(true);

      const server = startServer(0);
      const modelsUrl = `http://127.0.0.1:${server.port}/v1/models`;
      try {
        expect(server.hostname).toBe("0.0.0.0");
        expect((await fetch(modelsUrl)).status).toBe(401);
        const ok = await fetch(modelsUrl, {
          headers: { "x-opencodex-api-key": "container-secret" },
        });
        expect(ok.status).toBe(200);
      } finally {
        await server.stop(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("OPENCODEX_BIND_HOST env bind stays out of config.json after startServer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-container-bind-persist-"));
    try {
      process.env.OPENCODEX_HOME = dir;
      process.env.OPENCODEX_API_AUTH_TOKEN = "container-secret";
      process.env.OPENCODEX_BIND_HOST = "0.0.0.0";
      saveConfig(loadConfig());

      const server = startServer(0);
      try {
        expect(server.hostname).toBe("0.0.0.0");
      } finally {
        await server.stop(true);
      }

      const raw = JSON.parse(
        await Bun.file(join(dir, "config.json")).text(),
      ) as Record<string, unknown>;
      expect(raw.hostname).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("entrypoint exports token from file and execs the command", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-container-"));
    try {
      const tokenFile = join(dir, "token");
      writeFileSync(tokenFile, "test-file-token\n", { mode: 0o600 });
      const result = Bun.spawnSync(
        ["/bin/sh", entrypoint, "printenv", "OPENCODEX_API_AUTH_TOKEN"],
        {
          cwd: repoRoot,
          env: { ...process.env, OPENCODEX_API_AUTH_TOKEN_FILE: tokenFile },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(result.exitCode).toBe(0);
      expect(new TextDecoder().decode(result.stdout).trim()).toBe(
        "test-file-token",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
