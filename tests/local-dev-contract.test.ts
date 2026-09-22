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

  test("systemd unit keeps the compose place lock and documents 1.4.2 / 529bb6a9", async () => {
    const unit = await readRepo("deploy/container/opencodex-proxy.service");
    expect(unit).toContain(
      "ExecStart=/usr/bin/docker compose up -d --remove-orphans",
    );
    expect(unit).toContain("ExecStop=/usr/bin/docker compose down");
    expect(unit).toContain("WorkingDirectory=/opt/chef/deploy/opencodex");
    expect(unit).toContain("EnvironmentFile=-/opt/chef/deploy/opencodex/.env");
    expect(unit).toContain(
      "After=docker.service network-online.target tailscaled.service",
    );
    expect(unit).toContain("1.4.2");
    expect(unit).toContain("529bb6a9c0ab2650f883e88c9373002ed1eb14f7");
    expect(unit).toContain("GET :10100/healthz");
  });

  test(".env.example and OIDC placeholder carry redirects and no secrets", async () => {
    const envExample = await readRepo(".env.example");
    expect(envExample).toContain(
      "OIDC_ISSUER=https://auth.chefgroep.online/application/o/ocx/",
    );
    expect(envExample).toContain("OIDC_CLIENT_ID=chefgroep-ocx-oidc");
    expect(envExample).toContain("OIDC_CLIENT_SECRET_FILE=");
    expect(envExample).toContain("OIDC_ALLOWED_HOSTS=");
    expect(envExample).toContain("CUTOVER-CHECKLIST.md");
    expect(envExample).toContain("APPLY DONE 2026-09-18");
    expect(envExample).toContain(
      "OIDC_REDIRECT_URI=http://127.0.0.1:10100/oauth/callback",
    );
    expect(envExample).toContain("https://ocx.chefgroep.online/oauth/callback");
    expect(envExample).toContain("529bb6a9c0ab2650f883e88c9373002ed1eb14f7");
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
    expect(oidc.status).toBe("consumer-wired");
    expect(oidc.application.client_secret).toBeNull();
    expect(oidc.application.client_id).toBe("chefgroep-ocx-oidc");
    expect(oidc.application.issuer).toBe(
      "https://auth.chefgroep.online/application/o/ocx/",
    );
    expect(oidc.notes.join("\n")).toContain("APPLY DONE 2026-09-18");
    expect(oidc.notes.join("\n")).toContain("not DNS HOLD");
    expect(oidc.notes.join("\n")).toContain(
      "The proxy verifies Authentik ID tokens",
    );
    expect(oidc.notes.join("\n")).toContain(
      "Cloudflare Access remains the live public-host dashboard gate",
    );
    expect(oidc.notes.join("\n")).toContain("CUTOVER-CHECKLIST.md");
    expect(oidc.application.redirect_uris).toEqual([
      "http://127.0.0.1:10100/oauth/callback",
      "http://localhost:10100/oauth/callback",
      "https://ocx.chefgroep.online/oauth/callback",
    ]);
    expect(oidc.application.post_logout_redirect_uris).toContain(
      "https://ocx.chefgroep.online/",
    );

    const operatorNotes = await readRepo("deploy/container/README.md");
    expect(operatorNotes).toContain("APPLY DONE 2026-09-18");
    expect(operatorNotes).toContain("chefgroep-ocx-oidc");
    expect(operatorNotes).toContain("Cloudflare Access remains the live");
    expect(operatorNotes).toMatch(/\*\*not\*\* DNS HOLD/);
    expect(operatorNotes).toContain("Do not deploy this PR to bc-scan-2");
    expect(operatorNotes).toContain("CUTOVER-CHECKLIST.md");
    expect(operatorNotes).toContain("verifies Authentik ID tokens");
    expect(operatorNotes).not.toMatch(
      /Authentik product gate is greenfield: no live issuer/,
    );
    expect(operatorNotes).not.toMatch(
      /The proxy does \*\*not\*\* verify Authentik tokens yet/,
    );
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

  test("oidc-authorize-canary.sh probes discovery/JWKS and optional /oauth/login", async () => {
    const script = await readRepo("scripts/oidc-authorize-canary.sh");
    expect(script).toContain(
      "https://auth.chefgroep.online/application/o/ocx/",
    );
    expect(script).toContain("chefgroep-ocx-oidc");
    expect(script).toContain(".well-known/openid-configuration");
    expect(script).toContain("/oauth/login");
    expect(script).toContain("code_challenge=");
    expect(script).not.toMatch(/OIDC_CLIENT_SECRET=/);
    expect(script).not.toMatch(/\bsk-[A-Za-z0-9_-]{20,}\b/);

    const checklist = await readRepo("deploy/oidc/CUTOVER-CHECKLIST.md");
    expect(checklist).toContain("Cloudflare Access remains the live");
    expect(checklist).toContain("GET /oauth/login");
    expect(checklist).toContain("Do not apply Cloudflare DNS");
    expect(checklist).toContain("ChefFactory");
    expect(checklist).toContain("1.4.2");
    expect(checklist).toContain(":10100");
  });
});

describe("healthz-smoke against a live proxy", () => {
  test("accepts identity-ok /healthz and rejects a foreign body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-healthz-smoke-"));
    process.env.OPENCODEX_HOME = dir;
    const server = startServer(0);
    try {
      const ok = await runHealthzSmoke({
        OPENCODEX_HEALTH_URL: `http://127.0.0.1:${server.port}/healthz`,
        OPENCODEX_SMOKE_EXPECT_VERSION: "1.5.0",
      });
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout).toContain('"service": "opencodex"');
      expect(ok.stdout).toContain('"version": "1.5.0"');
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
});
