import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const cli = join(import.meta.dir, "../src/cli/index.ts");
async function waitForFixtureProxy(port: number, previousPid?: number): Promise<{ pid: number }> {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      const body = await response.json() as { service: string; status: string; pid: number };
      if (response.ok && body.service === "opencodex" && body.status === "ok" && body.pid !== previousPid) return body;
    } catch { /* only the isolated test process may still be binding */ }
    await Bun.sleep(25);
  }
  throw new Error("Isolated proxy did not become healthy");
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ocx-independent-home-"));
  const codex = mkdtempSync(join(tmpdir(), "ocx-independent-codex-"));
  dirs.push(home, codex);
  writeFileSync(join(home, "config.json"), JSON.stringify({
    providers: {}, port: 10100, codexAccountPools: false, checkForUpdates: false,
    syncResumeHistory: false, tokenGuardian: { enabled: false },
  }));
  return { home, codex, env: { ...process.env, OPENCODEX_HOME: home, CODEX_HOME: codex,
    OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: join(home, "desktop"), OPENCODEX_ADMIN_AUTH_TOKEN: "fixture-admin", HOME: home, USERPROFILE: home, CI: "1" } };
}
async function run(args: string[], env: NodeJS.ProcessEnv) {
  const child = Bun.spawn([process.execPath, cli, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, status };
}

test("default sync succeeds without Codex; explicit Codex sync reports absence", async () => {
  const f = fixture();
  const result = await run(["sync"], f.env);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Codex: skipped (not configured)");
  expect(readdirSync(f.codex)).toEqual([]);
  const explicit = await run(["sync", "--codex-only"], f.env);
  expect(explicit.status).toBe(1);
  expect(`${explicit.stdout}\n${explicit.stderr}`).toContain("Codex config not found");
});

for (const kind of ["ambiguous", "missing", "file"] as const) {
test(`Desktop sync commits independently of Codex failure (${kind})`, async () => {
  const f = fixture();
  if (kind !== "ambiguous") {
    f.env.CODEX_HOME = join(f.home, "invalid-codex");
    if (kind === "file") writeFileSync(f.env.CODEX_HOME, "not a directory\n");
  }
  const library = f.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  mkdirSync(library, { recursive: true });
  mkdirSync(join(f.home, ".claude"));
  writeFileSync(join(library, "_meta.json"), JSON.stringify({
    entries: [{ id: "old", name: "opencodex" }, { id: "user", name: "My profile" }], appliedId: "old",
  }));
  const codexConfig = [
    "# Managed by opencodex: native subagent defaults table", "[agents]",
    "# Managed by opencodex: native subagent default", "", 'default_subagent_model = "gpt-5.6-sol"', "",
  ].join("\n");
  writeFileSync(join(f.codex, "config.toml"), codexConfig);
  const calls: string[] = [];
  const gateway = Bun.serve({ port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    calls.push(path);
    if (path === "/healthz") return Response.json({ service: "opencodex", status: "ok" });
    if (req.headers.get("authorization") !== "Bearer fixture-admission") return new Response(null, { status: 401 });
    return Response.json({ ok: true, appliedId: "new", meta: {
      appliedId: "new", entries: [{ id: "new", name: "opencodex" }],
    }, config: { inferenceGatewayApiKey: "fixture-only-key", inferenceModels: [{ name: "test" }] } });
  } });
  const origin = `http://127.0.0.1:${gateway.port}`;
  writeFileSync(join(f.home, ".claude", "settings.json"), JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: origin, ANTHROPIC_AUTH_TOKEN: "fixture-admission",
  } }));
  try {
    const env = { ...f.env };
    for (const key of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENCODEX_API_KEY", "OPENCODEX_API_AUTH_TOKEN"]) delete env[key];
    const result = await run(["sync"], env);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Claude Desktop: 1 models synced.");
    if (kind === "ambiguous") {
      expect(`${result.stdout}\n${result.stderr}`).toContain("Codex config injection refused");
      expect(result.stderr).toContain("Codex sync did not complete");
    } else {
      expect(result.stderr).toContain("CODEX_HOME points to");
      expect(result.stdout).not.toContain("Codex: skipped");
    }
    expect(calls).toContain("/v1/claude-desktop-3p-library");
    expect(JSON.parse(readFileSync(join(library, "_meta.json"), "utf8")).entries).toEqual([
      { id: "user", name: "My profile" }, { id: "new", name: "opencodex" },
    ]);
    expect(JSON.parse(readFileSync(join(library, "new.json"), "utf8")).inferenceGatewayBaseUrl).toBe(origin);
    expect(readFileSync(join(f.codex, "config.toml"), "utf8")).toBe(codexConfig);
    if (kind !== "ambiguous") {
      const explicit = await run(["sync", "--desktop-only"], env);
      expect(explicit.status).toBe(0);
      expect(explicit.stdout).toContain("Claude Desktop: 1 models unchanged.");
      expect((await run(["claude", "desktop", "sync"], env)).status).toBe(0);
      expect(existsSync(join(f.home, ".codex"))).toBe(false);
    }
  } finally { gateway.stop(true); }
});
}

for (const kind of ["missing", "file"] as const) {
  test(`invalid explicit CODEX_HOME (${kind}) does not block independent clients or redirect writes`, async () => {
    const f = fixture();
    const invalid = join(f.home, "invalid-codex");
    if (kind === "file") writeFileSync(invalid, "not a directory\n");
    const env = { ...f.env, CODEX_HOME: invalid };
    for (const args of [["help"], ["--version"]]) expect((await run(args, env)).status).toBe(0);
    for (const args of [["start"], ["sync", "--codex-only"], ["sync"]]) {
      const result = await run(args, env);
      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain("CODEX_HOME points to");
      expect(result.stdout).not.toContain("Codex: skipped");
    }
    expect(existsSync(join(f.home, ".codex"))).toBe(false);
    expect(existsSync(join(f.home, "ocx.pid"))).toBe(false);
    expect(existsSync(join(f.home, "runtime-port.json"))).toBe(false);
    if (kind === "file") expect(readFileSync(invalid, "utf8")).toBe("not a directory\n");
    else expect(existsSync(invalid)).toBe(false);
  });
}

test("sync rejects conflicting selectors before touching client state", async () => {
  const f = fixture();
  for (const flags of [["--desktop-only", "--codex-only"], ["--desktop-only", "--restart-codex"], ["--unknown"]]) {
    const result = await run(["sync", ...flags], f.env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: ocx sync");
    expect(readdirSync(f.codex)).toEqual([]);
  }
});

for (const pidFileState of ["present", "missing", "stale"] as const) {
  test(`proxy-only restart preserves mode and client bytes (${pidFileState} pid file)`, async () => {
    const f = fixture();
    f.env.CODEX_HOME = join(f.home, "missing-codex");
    const configPath = join(f.codex, "config.toml");
    writeFileSync(configPath, 'model = "unchanged"\n');
    writeFileSync(join(f.home, ".zshrc"), "# untouched\n");
    const reserved = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = reserved.port!;
    reserved.stop(true);
    const child = Bun.spawn([process.execPath, cli, "start", "--proxy-only", "--port", String(port)], {
      env: f.env, stdout: "pipe", stderr: "pipe",
    });
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    try {
      const first = await waitForFixtureProxy(port);
      if (pidFileState === "missing") unlinkSync(join(f.home, "ocx.pid"));
      if (pidFileState === "stale") writeFileSync(join(f.home, "ocx.pid"), "99999999\n");
      const restarted = await run(["restart"], f.env);
      if (restarted.status !== 0) throw new Error(`Fixture restart failed (${restarted.status}): ${restarted.stdout}\n${restarted.stderr}`);
      expect(restarted.status).toBe(0);
      const next = await waitForFixtureProxy(port, first.pid);
      const runtime = JSON.parse(readFileSync(join(f.home, "runtime-port.json"), "utf8"));
      expect(runtime).toMatchObject({ pid: next.pid, port, proxyOnly: true });
      expect(readFileSync(configPath, "utf8")).toBe('model = "unchanged"\n');
      expect(readFileSync(join(f.home, ".zshrc"), "utf8")).toBe("# untouched\n");
      expect(existsSync(join(f.home, "missing-codex"))).toBe(false);
      expect((await run(["stop"], f.env)).status).toBe(0);
    } finally {
      await fetch(`http://127.0.0.1:${port}/api/stop`, {
        method: "POST", headers: { "x-opencodex-api-key": "fixture-admin" },
      }).catch(() => {});
      child.kill("SIGTERM");
      await child.exited;
      await output;
    }
  }, 15000);
}

for (const kind of ["valid", "missing", "file"] as const) {
test(`proxy-only serves health and API without changing client files (${kind} CODEX_HOME), including on shutdown`, async () => {
  const f = fixture();
  if (kind !== "valid") {
    f.env.CODEX_HOME = join(f.home, "invalid-codex");
    if (kind === "file") writeFileSync(f.env.CODEX_HOME, "not a directory\n");
  }
  const configPath = join(f.codex, "config.toml");
  const config = 'model = "my-model"\n';
  writeFileSync(configPath, config);
  writeFileSync(join(f.home, ".zshrc"), "# existing shell config\n");
  const reserved = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reserved.port!;
  reserved.stop(true);
  const child = Bun.spawn([process.execPath, cli, "start", "--proxy-only", "--port", String(port)], {
    env: f.env, stdout: "pipe", stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`);
        const body = await response.json() as { service: string; status: string };
        if (response.ok && body.service === "opencodex" && body.status === "ok") { healthy = true; break; }
      } catch { /* only this isolated test child may still be binding */ }
      await Bun.sleep(25);
    }
    expect(healthy).toBe(true);
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`);
    expect(response.status).toBe(200);
    expect(Array.isArray((await response.json() as { data: unknown[] }).data)).toBe(true);
    const stopped = await fetch(`http://127.0.0.1:${port}/api/stop`, {
      method: "POST", headers: { "x-opencodex-api-key": "fixture-admin" },
    });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toEqual({ success: true, message: "Proxy stopping; client configuration unchanged." });
    await child.exited;
  } finally {
    child.kill("SIGTERM");
    await child.exited;
    await Promise.all([stdout, stderr]);
  }
  expect(readFileSync(configPath, "utf8")).toBe(config);
  expect(readdirSync(f.codex)).toEqual(["config.toml"]);
  expect(readFileSync(join(f.home, ".zshrc"), "utf8")).toBe("# existing shell config\n");
  expect(existsSync(join(f.home, ".codex"))).toBe(false);
});
}
