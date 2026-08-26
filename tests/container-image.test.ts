import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const healthScript = join(repoRoot, "scripts/container-health.ts");
const entrypoint = join(repoRoot, "scripts/container-entrypoint.sh");

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
    const compose = await Bun.file(join(repoRoot, "deploy/container/compose.example.yml")).text();
    expect(dockerfile).toContain('CMD ["bun", "run", "scripts/container-health.ts"]');
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/container-entrypoint.sh"]');
    expect(compose).toContain("OPENCODEX_IMAGE:?pin an immutable image digest");
    expect(compose).toContain("OPENCODEX_API_AUTH_TOKEN_FILE: /run/secrets/opencodex_api_token");
    expect(compose).not.toMatch(/^(\s*)OPENCODEX_API_AUTH_TOKEN:/m);
  });

  test("health probe accepts identity-ok /healthz and rejects mismatch", async () => {
    const ok = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ status: "ok", service: "opencodex", pid: 1, port: 10100 }),
    });
    try {
      expect((await runHealth(ok.port)).exitCode).toBe(0);
    } finally {
      ok.stop(true);
    }

    const bad = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ status: "ok", service: "not-opencodex", pid: 1, port: 10100 }),
    });
    try {
      const result = await runHealth(bad.port);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("health identity mismatch");
    } finally {
      bad.stop(true);
    }
  });

  test("entrypoint exports token from file and execs the command", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-container-"));
    try {
      const tokenFile = join(dir, "token");
      writeFileSync(tokenFile, "test-file-token\n", { mode: 0o600 });
      const result = Bun.spawnSync(["/bin/sh", entrypoint, "printenv", "OPENCODEX_API_AUTH_TOKEN"], {
        cwd: repoRoot,
        env: { ...process.env, OPENCODEX_API_AUTH_TOKEN_FILE: tokenFile },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      expect(new TextDecoder().decode(result.stdout).trim()).toBe("test-file-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
