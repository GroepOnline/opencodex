import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/server";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const previousHome = process.env.OPENCODEX_HOME;

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
});

async function readRepo(rel: string): Promise<string> {
  return await Bun.file(join(repoRoot, rel)).text();
}

async function runHealthzSmoke(env: Record<string, string>): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn(["bash", join(repoRoot, "scripts/healthz-smoke.sh")], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/**
 * Block until the live endpoint identifies itself as opencodex.
 *
 * `startServer(0)` returns as soon as `Bun.serve` has bound the socket, but the
 * smoke script's `curl` is the *first* client to connect, so it still races the
 * listener's accept loop. On a CI runner executing `bun test --isolate` with ~80
 * files per batch — each spawning `bash`, `curl`, and `python3` concurrently —
 * that first connect can be refused outright, and the script reports it as
 * `unreachable` with exit 1.
 *
 * The script's own 4s `--max-time` is not what fires here: a refused connect
 * returns in milliseconds, which is why the recorded failures took the same
 * 45-80ms as a passing run. Readiness is therefore established here, in-process
 * and with a real response to assert on, before the shell probe is allowed to run.
 */
async function waitForHealthz(port: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt made";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      const body = (await res.json()) as { service?: unknown };
      if (body.service === "opencodex") return;
      lastError = `responded with service=${JSON.stringify(body.service)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(25);
  }
  throw new Error(`healthz never became ready on :${port} (${lastError})`);
}

describe("local/dev complete path", () => {
  test("compose, devcontainer, env example, and healthz smoke exist", async () => {
    for (const rel of [
      "compose.yml",
      ".env.example",
      ".devcontainer/devcontainer.json",
      ".devcontainer/Dockerfile",
      ".devcontainer/post-create.sh",
      ".devcontainer/README.md",
      "deploy/container/README.md",
      "deploy/container/compose.example.yml",
      "deploy/container/opencodex-proxy.service",
      "deploy/oidc/authentik-ocx-client.placeholder.json",
      "deploy/oidc/CUTOVER-CHECKLIST.md",
      "scripts/healthz-smoke.sh",
      "scripts/oidc-authorize-canary.sh",
    ]) {
      expect(await Bun.file(join(repoRoot, rel)).exists()).toBe(true);
    }
  });

  test("local compose binds loopback :10100 and uses the prod health probe", async () => {
    const compose = await readRepo("compose.yml");
    expect(compose).toContain("dockerfile: Dockerfile");
    expect(compose).toContain('"127.0.0.1:10100:10100"');
    expect(compose).toContain(
      'test: ["CMD", "bun", "run", "scripts/container-health.ts"]',
    );
    expect(compose).toContain(
      "OPENCODEX_API_AUTH_TOKEN_FILE: /run/secrets/opencodex_api_token",
    );
    expect(compose).not.toMatch(/OPENCODEX_BIND_IP/);
    expect(compose).not.toMatch(/^(\s*)OPENCODEX_API_AUTH_TOKEN:/m);
    expect(compose).not.toMatch(/^(\s*)OIDC_CLIENT_SECRET:/m);
    expect(compose).toContain(
      "OIDC_CLIENT_SECRET_FILE: ${OIDC_CLIENT_SECRET_FILE:-}",
    );
    expect(compose).toContain(
      "OIDC_REDIRECT_URI: ${OIDC_REDIRECT_URI:-http://127.0.0.1:10100/oauth/callback}",
    );
    expect(compose).toContain("OIDC_ALLOWED_HOSTS: ${OIDC_ALLOWED_HOSTS:-}");
  });

  test("prod compose still requires an image digest and Tailscale bind", async () => {
    const compose = await readRepo("deploy/container/compose.example.yml");
    expect(compose).toContain("OPENCODEX_IMAGE:?pin an immutable image digest");
    expect(compose).toContain(
      "${OPENCODEX_BIND_IP:?set the host Tailscale IPv4}:10100:10100",
    );
    expect(compose).toContain("OIDC_ISSUER: ${OIDC_ISSUER:-}");
    expect(compose).toContain("OIDC_CLIENT_ID: ${OIDC_CLIENT_ID:-}");
    expect(compose).toContain(
      "OIDC_CLIENT_SECRET_FILE: ${OIDC_CLIENT_SECRET_FILE:-}",
    );
    expect(compose).toContain("OIDC_ALLOWED_HOSTS: ${OIDC_ALLOWED_HOSTS:-}");
    expect(compose).not.toMatch(/\bOIDC_CLIENT_SECRET:/);
    expect(compose).not.toContain("OIDC_CLIENT_SECRET_FILE:?");
  });

  test("systemd example is deployment-neutral and compose-only", async () => {
    const unit = await readRepo("deploy/container/opencodex-proxy.service");
    expect(unit).toContain(
      "ExecStart=/usr/bin/docker compose up -d --remove-orphans",
    );
    expect(unit).toContain("ExecStop=/usr/bin/docker compose down");
    expect(unit).toContain("WorkingDirectory=/opt/opencodex");
    expect(unit).toContain("EnvironmentFile=-/opt/opencodex/.env");
    expect(unit).toContain(
      "After=docker.service network-online.target tailscaled.service",
    );
    expect(unit).toContain("Wants=network-online.target tailscaled.service");
    expect(unit).not.toContain("/opt/chef/");
    expect(unit).not.toMatch(/100\.\d+\.\d+\.\d+/);
    expect(unit).not.toMatch(/[0-9a-f]{40}/);
  });

  test(".env.example and OIDC placeholder are generic and secret-free", async () => {
    const envExample = await readRepo(".env.example");
    expect(envExample).toContain(
      "OIDC_ISSUER=https://id.example.com/application/o/opencodex/",
    );
    expect(envExample).toContain("OIDC_CLIENT_ID=opencodex");
    expect(envExample).toContain("OIDC_CLIENT_SECRET_FILE=");
    expect(envExample).toContain("OIDC_ALLOWED_HOSTS=");
    expect(envExample).toContain(
      "OIDC_REDIRECT_URI=http://127.0.0.1:10100/oauth/callback",
    );
    expect(envExample).not.toContain("chefgroep.online");
    expect(envExample).not.toMatch(/[0-9a-f]{40}/);
    expect(envExample).not.toMatch(/OIDC_CLIENT_SECRET=/);
    expect(envExample).not.toMatch(/\bsk-[A-Za-z0-9_-]{20,}\b/);
    expect(envExample).not.toMatch(/\bghp_[A-Za-z0-9_]{20,}\b/);

    const oidc = JSON.parse(
      await readRepo("deploy/oidc/authentik-ocx-client.placeholder.json"),
    ) as {
      status: string;
      notes: string[];
      application: {
        client_secret: unknown;
        client_id: string;
        issuer: string;
        redirect_uris: string[];
        post_logout_redirect_uris: string[];
      };
    };
    expect(oidc.status).toBe("example-only");
    expect(oidc.application.client_secret).toBeNull();
    expect(oidc.application.client_id).toBe("opencodex");
    expect(oidc.application.issuer).toBe(
      "https://id.example.com/application/o/opencodex/",
    );
    expect(oidc.application.redirect_uris).toEqual([
      "http://127.0.0.1:10100/oauth/callback",
      "http://localhost:10100/oauth/callback",
      "https://opencodex.example.com/oauth/callback",
    ]);
    expect(oidc.application.post_logout_redirect_uris).toContain(
      "https://opencodex.example.com/",
    );
    expect(oidc.notes.join("\n")).toContain("product example");
    expect(oidc.notes.join("\n")).toContain("OIDC_CLIENT_SECRET_FILE");

    const operatorNotes = await readRepo("deploy/container/README.md");
    expect(operatorNotes).toContain("Production boundary");
    expect(operatorNotes).toContain("private deployment");
    expect(operatorNotes).toContain("CUTOVER-CHECKLIST.md");
    expect(operatorNotes).not.toContain("chefgroep.online");
    expect(operatorNotes).not.toMatch(/100\.\d+\.\d+\.\d+/);
    expect(operatorNotes).not.toMatch(/\/home\/[A-Za-z0-9_-]+\//);
  });

  test("devcontainer forwards :10100 and bootstraps Bun 1.4.0", async () => {
    const config = JSON.parse(
      await readRepo(".devcontainer/devcontainer.json"),
    ) as {
      name: string;
      forwardPorts: number[];
      build: { dockerfile: string };
    };
    expect(config.name).toBe("opencodex");
    expect(config.forwardPorts).toContain(10100);
    expect(config.build.dockerfile).toBe("Dockerfile");
    expect(await readRepo(".devcontainer/Dockerfile")).toContain(
      "BUN_VERSION=1.4.0",
    );
    expect(await readRepo(".devcontainer/post-create.sh")).toContain(
      "bun install --frozen-lockfile",
    );
  });

  test("healthz-smoke.sh pins the live :10100/healthz identity contract", async () => {
    const script = await readRepo("scripts/healthz-smoke.sh");
    expect(script).toContain("http://${HOST}:${PORT}/healthz");
    expect(script).toContain("PORT:-10100");
    expect(script).toContain('body.get("status") != "ok"');
    expect(script).toContain('body.get("service") != "opencodex"');
    expect(script).toContain("OPENCODEX_SMOKE_EXPECT_SHA");
    expect(script).toContain("OPENCODEX_SMOKE_EXPECT_VERSION");
    expect(script).not.toMatch(/OPENCODEX_API_AUTH_TOKEN=/);
  });

  test("oidc-authorize-canary.sh requires deployment-owned issuer/client and probes discovery", async () => {
    const script = await readRepo("scripts/oidc-authorize-canary.sh");
    expect(script).toContain("OIDC_ISSUER is required");
    expect(script).toContain("OIDC_CLIENT_ID is required");
    expect(script).toContain(".well-known/openid-configuration");
    expect(script).toContain("/oauth/login");
    expect(script).toContain("code_challenge=");
    expect(script).not.toContain("auth.chefgroep.online");
    expect(script).not.toContain("chefgroep-ocx-oidc");
    expect(script).not.toMatch(/OIDC_CLIENT_SECRET=/);
    expect(script).not.toMatch(/\bsk-[A-Za-z0-9_-]{20,}\b/);

    const checklist = await readRepo("deploy/oidc/CUTOVER-CHECKLIST.md");
    expect(checklist).toContain("deployment-neutral");
    expect(checklist).toContain("GET /oauth/login");
    expect(checklist).toContain("Do not apply production DNS");
    expect(checklist).toContain("private deployment repository");
    expect(checklist).toContain("/v1/models");
    expect(checklist).not.toMatch(/100\.\d+\.\d+\.\d+/);
    expect(checklist).not.toMatch(/[0-9a-f]{40}/);
  });
});

describe("healthz-smoke against a live proxy", () => {
  test("accepts identity-ok /healthz and rejects a foreign body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-healthz-smoke-"));
    process.env.OPENCODEX_HOME = dir;
    const server = startServer(0);
    try {
      await waitForHealthz(server.port);
      const packageVersion = (
        JSON.parse(await readRepo("package.json")) as { version: string }
      ).version;
      const ok = await runHealthzSmoke({
        OPENCODEX_HEALTH_URL: `http://127.0.0.1:${server.port}/healthz`,
        OPENCODEX_SMOKE_EXPECT_VERSION: packageVersion,
      });
      // Surface the probe's own output on failure. A bare exit-code assertion
      // collapses "listener refused the connect" and "identity field missing"
      // into the same opaque Expected: 0 / Received: 1, which is what left
      // this flake undiagnosed across two separate failing runs.
      if (ok.exitCode !== 0) {
        throw new Error(
          `healthz-smoke.sh exited ${ok.exitCode}\n` +
            `stdout: ${ok.stdout.trim() || "(empty)"}\n` +
            `stderr: ${ok.stderr.trim() || "(empty)"}`,
        );
      }
      expect(ok.stdout).toContain('"service": "opencodex"');
      expect(ok.stdout).toContain(`"version": "${packageVersion}"`);
    } finally {
      await server.stop(true);
    }

    const foreign = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        Response.json({
          status: "ok",
          service: "not-opencodex",
          pid: 1,
          port: 10100,
          gitSha: "abc123",
          version: "1.4.2",
        }),
    });
    try {
      const result = await runHealthzSmoke({
        OPENCODEX_HEALTH_URL: `http://127.0.0.1:${foreign.port}/healthz`,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("health identity mismatch");
    } finally {
      foreign.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  // Guards the readiness helper itself: a port nothing is listening on must
  // fail loudly with its last probe error rather than hanging or passing, so a
  // future regression cannot quietly reintroduce the opaque exit-code failure.
  test("readiness wait fails loudly when nothing serves /healthz", async () => {
    const closed = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(""),
    });
    const port = closed.port;
    closed.stop(true);

    await expect(waitForHealthz(port, 300)).rejects.toThrow(
      /healthz never became ready/,
    );
  });
});
