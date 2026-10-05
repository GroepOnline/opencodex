import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncClaudeDesktopLibrary } from "../src/claude/desktop-sync";
import { atomicWriteFile } from "../src/config";

const dirs: string[] = [];
const originalHome = process.env.OPENCODEX_HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ocx-desktop-sync-"));
  dirs.push(dir);
  process.env.OPENCODEX_HOME = dir;
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({
    env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:10100" }, apiKeyHelper: "existing-helper",
  }));
  const metaPath = join(dir, "_meta.json");
  writeFileSync(metaPath, JSON.stringify({
    entries: [{ id: "old", name: "opencodex" }, { id: "user", name: "My profile" }], appliedId: "old", other: true,
  }));
  writeFileSync(join(dir, "old.json"), JSON.stringify({ inferenceGatewayApiKey: "local-test-secret" }), { mode: 0o600 });
  const payload = { ok: true, appliedId: "new", meta: {
    appliedId: "new", entries: [{ id: "new", name: "opencodex" }],
  }, config: { inferenceGatewayBaseUrl: "http://remote.example", inferenceGatewayApiKey: "fixture-only-key", inferenceModels: [{ id: "test" }] } };
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return Response.json(url.endsWith("/healthz") ? { status: "ok", service: "opencodex" } : payload);
  }) as typeof fetch;
  const options = { libraryPath: dir, settingsPath, env: {}, fetchImpl, runKeyHelper: () => "fixture-admission" };
  return { dir, metaPath, settingsPath, payload, calls, options };
}

test("API-only sync uses apiKeyHelper, preserves profiles and backups, and is idempotent", async () => {
  const f = fixture();
  expect(await syncClaudeDesktopLibrary({ ...f.options, automatic: true })).toEqual({ status: "synced", models: 1 });
  expect(f.calls.map(c => c.url)).toEqual([
    "http://127.0.0.1:10100/healthz", "http://127.0.0.1:10100/v1/claude-desktop-3p-library",
  ]);
  expect(new Headers(f.calls[1]!.init?.headers).get("authorization")).toBe("Bearer fixture-admission");
  expect(f.calls[1]!.init?.redirect).toBe("error");
  const config = JSON.parse(readFileSync(join(f.dir, "new.json"), "utf8"));
  expect(config.inferenceGatewayBaseUrl).toBe("http://127.0.0.1:10100");
  const meta = JSON.parse(readFileSync(f.metaPath, "utf8"));
  expect(meta.entries).toEqual([{ id: "user", name: "My profile" }, { id: "new", name: "opencodex" }]);
  expect(meta.other).toBe(true);
  expect(existsSync(join(f.dir, "old.json"))).toBe(true);
  if (process.platform !== "win32") expect(statSync(join(f.dir, "new.json")).mode & 0o777).toBe(0o600);
  const backups = readdirSync(f.dir).filter(p => p.endsWith(".bak"));
  expect(backups.length).toBe(1);
  expect(await syncClaudeDesktopLibrary(f.options)).toEqual({ status: "unchanged", models: 1 });
  expect(readdirSync(f.dir).filter(p => p.endsWith(".bak"))).toEqual(backups);
});

test("Desktop sync resolves settings from the injected Claude config directory", async () => {
  const f = fixture();
  const configDir = join(f.dir, "isolated-claude");
  mkdirSync(configDir);
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: "http://127.0.0.1:10100", ANTHROPIC_AUTH_TOKEN: "fixture-config-key",
  } }));
  await syncClaudeDesktopLibrary({ ...f.options, settingsPath: undefined,
    env: { CLAUDE_CONFIG_DIR: configDir },
    runKeyHelper: () => { throw new Error("Wrong settings source"); },
  });
  expect(new Headers(f.calls[1]!.init?.headers).get("authorization")?.slice(7)).toBe("fixture-config-key");
  expect(await syncClaudeDesktopLibrary({ ...f.options, env: { CLAUDE_CONFIG_DIR: join(f.dir, "missing") } }))
    .toEqual({ status: "unchanged", models: 1 });
});

for (const source of ["explicit-file", "default-file", "marker-helper"] as const) {
  test(`Desktop sync follows existing admission credentials (${source})`, async () => {
    const f = fixture();
    const tokenPath = join(f.dir, "service-api-token");
    let helpers = 0;
    const env: NodeJS.ProcessEnv = { ANTHROPIC_AUTH_TOKEN: "opencodex-proxy" };
    if (source === "explicit-file") {
      writeFileSync(tokenPath, "fixture-file-admission\n", { mode: 0o600 });
      env.OCX_API_TOKEN_FILE = tokenPath;
    } else if (source === "default-file") {
      writeFileSync(tokenPath, "fixture-file-admission\n", { mode: 0o600 });
    }
    await syncClaudeDesktopLibrary({ ...f.options, env, runKeyHelper: () => {
      helpers++;
      return "fixture-helper-key";
    } });
    const authorization = new Headers(f.calls[1]!.init?.headers).get("authorization");
    expect(authorization?.startsWith("Bearer ")).toBe(true);
    expect(authorization?.slice(7)).toBe(source === "marker-helper" ? "fixture-helper-key" : "fixture-file-admission");
    expect(helpers).toBe(source === "marker-helper" ? 1 : 0);
  });
}

for (const failure of ["throw", "soft-failure"] as const) {
  test(`failed backup hardening leaves no secret bytes (${failure})`, async () => {
    const f = fixture();
    const before = readFileSync(f.metaPath);
    let target = "";
    await expect(syncClaudeDesktopLibrary({ ...f.options, fileIO: { harden: path => {
      target = path;
      expect(readFileSync(path).byteLength).toBe(0);
      if (failure === "throw") throw new Error("ACL failure");
      return { ok: false };
    } } })).rejects.toThrow(failure === "throw" ? "Claude Desktop sync failed" : "could not protect");
    expect(target.endsWith(".bak")).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(f.metaPath)).toEqual(before);
    expect(existsSync(join(f.dir, "new.json"))).toBe(false);
  });
}

for (const sameId of [false, true]) {
  test(`metadata failure rolls back the configuration (${sameId ? "existing" : "new"} id)`, async () => {
    const f = fixture();
    if (sameId) {
      f.payload.appliedId = "old";
      f.payload.meta.appliedId = "old";
      f.payload.meta.entries[0]!.id = "old";
    }
    const path = join(f.dir, `${f.payload.appliedId}.json`);
    const before = existsSync(path) ? readFileSync(path) : null;
    const meta = readFileSync(f.metaPath);
    const writes: string[] = [];
    await expect(syncClaudeDesktopLibrary({ ...f.options, fileIO: { atomicWrite: (target, content) => {
      writes.push(target);
      if (target === f.metaPath) throw new Error("sharing violation");
      atomicWriteFile(target, typeof content === "string" ? content : content.toString("utf8"));
    } } })).rejects.toThrow("configuration was rolled back");
    expect(writes.slice(0, 2)).toEqual([path, f.metaPath]);
    expect(existsSync(path)).toBe(before !== null);
    if (before) expect(readFileSync(path)).toEqual(before);
    expect(readFileSync(f.metaPath)).toEqual(meta);
  });
}

test("rollback preserves concurrent configuration changes", async () => {
  const f = fixture();
  const configPath = join(f.dir, "new.json");
  await expect(syncClaudeDesktopLibrary({ ...f.options, fileIO: { atomicWrite: (target, content) => {
    if (target === f.metaPath) {
      writeFileSync(configPath, "concurrent user configuration\n");
      throw new Error("sharing violation");
    }
    atomicWriteFile(target, typeof content === "string" ? content : content.toString("utf8"));
  } } })).rejects.toThrow("configuration rollback failed");
  expect(readFileSync(configPath, "utf8")).toBe("concurrent user configuration\n");
});

test("rollback failure is reported separately without exposing filesystem details", async () => {
  const f = fixture();
  f.payload.appliedId = "old";
  f.payload.meta.appliedId = "old";
  f.payload.meta.entries[0]!.id = "old";
  let writes = 0;
  await expect(syncClaudeDesktopLibrary({ ...f.options, fileIO: { atomicWrite: (target, content) => {
    if (++writes > 1) throw new Error("fixture-sensitive-path");
    atomicWriteFile(target, typeof content === "string" ? content : content.toString("utf8"));
  } } })).rejects.toThrow("configuration rollback failed; protected backups are available");
  expect(readdirSync(f.dir).filter(path => path.endsWith(".bak")).length).toBe(2);
});

test("automatic sync does not initialize an unrelated Desktop library", async () => {
  const f = fixture();
  writeFileSync(f.metaPath, JSON.stringify({ entries: [{ id: "user", name: "My profile" }], appliedId: "user" }));
  expect(await syncClaudeDesktopLibrary({ ...f.options, automatic: true })).toEqual({ status: "skipped", models: 0 });
  expect(f.calls.length).toBe(0);
});

test("rejects non-loopback gateways before invoking a credential helper", async () => {
  const f = fixture();
  let helperRan = false;
  writeFileSync(f.settingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://untrusted.example" }, apiKeyHelper: "existing-helper" }));
  await expect(syncClaudeDesktopLibrary({ ...f.options, runKeyHelper: () => { helperRan = true; return "secret"; } })).rejects.toThrow("loopback");
  expect(helperRan).toBe(false);
  expect(f.calls.length).toBe(0);
});

test("failure to fetch the applied library fails closed with no writes or alternate transport", async () => {
  const f = fixture();
  const before = readFileSync(f.metaPath, "utf8");
  f.options.fetchImpl = (async (input: string | URL | Request) => String(input).endsWith("/healthz")
    ? Response.json({ status: "ok", service: "opencodex" }) : new Response("sensitive-body", { status: 401 })) as typeof fetch;
  await expect(syncClaudeDesktopLibrary(f.options)).rejects.toThrow("HTTP 401");
  expect(readFileSync(f.metaPath, "utf8")).toBe(before);
  expect(existsSync(join(f.dir, "new.json"))).toBe(false);
});

test("rejects traversal, conflicting profile ids and malformed envelopes before writes", async () => {
  for (const kind of ["traversal", "conflict", "orphan-profile", "invalid-meta"] as const) {
    const f = fixture();
    if (kind === "traversal") f.payload.appliedId = "../outside";
    if (kind === "conflict") {
      f.payload.appliedId = "user";
      f.payload.meta.appliedId = "user";
      f.payload.meta.entries[0]!.id = "user";
    }
    if (kind === "orphan-profile") writeFileSync(join(f.dir, "new.json"), "unregistered user profile\n");
    if (kind === "invalid-meta") f.payload.meta.appliedId = "mismatch";
    const before = readFileSync(f.metaPath, "utf8");
    await expect(syncClaudeDesktopLibrary(f.options)).rejects.toThrow();
    expect(readFileSync(f.metaPath, "utf8")).toBe(before);
    if (kind === "orphan-profile") expect(readFileSync(join(f.dir, "new.json"), "utf8")).toBe("unregistered user profile\n");
  }
});

test("malformed JSON and transport errors never expose secret-bearing details", async () => {
  for (const kind of ["json", "transport"] as const) {
    const f = fixture();
    f.options.fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/healthz")) return Response.json({ status: "ok", service: "opencodex" });
      if (kind === "transport") throw new Error("fixture-sensitive-body");
      return new Response('{"fixture-sensitive-body": broken');
    }) as typeof fetch;
    let message = "";
    try { await syncClaudeDesktopLibrary(f.options); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("Claude Desktop sync failed");
    expect(message).not.toContain("fixture-sensitive-body");
    expect(existsSync(join(f.dir, "new.json"))).toBe(false);
  }
});

test("concurrent meta change is preserved and reported before config writes", async () => {
  const f = fixture();
  f.options.runKeyHelper = () => {
    writeFileSync(f.metaPath, JSON.stringify({ entries: [{ id: "user", name: "Updated profile" }] }));
    return "fixture-admission";
  };
  await expect(syncClaudeDesktopLibrary(f.options)).rejects.toThrow("changed during sync");
  expect(readFileSync(f.metaPath, "utf8")).toContain("Updated profile");
  expect(existsSync(join(f.dir, "new.json"))).toBe(false);
});

test("existing backup content must match the snapshot before any replacement", async () => {
  const f = fixture();
  const before = readFileSync(f.metaPath);
  const digest = createHash("sha256").update(before).digest("hex").slice(0, 16);
  writeFileSync(`${f.metaPath}.before-sync-${digest}.bak`, "unrelated user data");
  await expect(syncClaudeDesktopLibrary(f.options)).rejects.toThrow("backup conflicts");
  expect(readFileSync(f.metaPath)).toEqual(before);
  expect(existsSync(join(f.dir, "new.json"))).toBe(false);
});

test("library and backup symlinks are refused without changing their targets", async () => {
  if (process.platform === "win32") return;
  const f = fixture();
  const link = join(f.dir, "library-link");
  symlinkSync(f.dir, link, "dir");
  await expect(syncClaudeDesktopLibrary({ ...f.options, libraryPath: link })).rejects.toThrow("symbolic-link");
  const before = readFileSync(f.metaPath);
  const digest = createHash("sha256").update(before).digest("hex").slice(0, 16);
  symlinkSync(f.metaPath, `${f.metaPath}.before-sync-${digest}.bak`);
  await expect(syncClaudeDesktopLibrary(f.options)).rejects.toThrow("non-regular");
  expect(readFileSync(f.metaPath)).toEqual(before);
});

test("bounded response rejects oversize without committing the library", async () => {
  const f = fixture();
  f.options.fetchImpl = (async (input: string | URL | Request) => String(input).endsWith("/healthz")
    ? Response.json({ status: "ok", service: "opencodex" })
    : new Response("", { headers: { "content-length": String(4 * 1024 * 1024 + 1) } })) as typeof fetch;
  await expect(syncClaudeDesktopLibrary(f.options)).rejects.toThrow("size limit");
  expect(existsSync(join(f.dir, "new.json"))).toBe(false);
});
