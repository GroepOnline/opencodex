import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCodexAuthAPI } from "../src/codex/auth-api";
import { saveConfig } from "../src/config";
import {
  clearGoogleAntigravityAccountPoolState,
  getGoogleAntigravityAccountHealthSnapshot,
  rotateGoogleAntigravityAccountOn429,
} from "../src/oauth/google-antigravity-routing";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

function cursorJwt(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    sub,
    email: `${sub.replace(/[^a-z0-9]+/gi, "-")}@example.test`,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString("base64url");
  return `${header}.${payload}.sig`;
}

function makeCodexConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    providers: {},
    defaultProvider: "openai",
    codexAccounts: [],
    ...overrides,
  };
}

describe("Codex account pool strategy management API", () => {
  const TEST_DIR = join(import.meta.dir, ".tmp-account-pool-mgmt-codex");
  let previousOpencodexHome: string | undefined;

  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = TEST_DIR;
  });

  afterEach(() => {
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("GET /api/codex-auth/active surfaces strategy defaults", async () => {
    const req = new Request("http://localhost/api/codex-auth/active", { method: "GET" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), makeCodexConfig());
    expect(resp!.status).toBe(200);
    expect(await resp!.json()).toMatchObject({
      accountPoolStrategy: "quota",
      accountPoolStickyLimit: 1,
    });
  });

  test("GET /api/codex-auth/active surfaces configured strategy", async () => {
    const config = makeCodexConfig({
      accountPoolStrategy: "round-robin",
      accountPoolStickyLimit: 3,
    });
    const req = new Request("http://localhost/api/codex-auth/active", { method: "GET" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    expect(await resp!.json()).toMatchObject({
      accountPoolStrategy: "round-robin",
      accountPoolStickyLimit: 3,
    });
  });

  test("PUT /api/codex-auth/pool-strategy rejects invalid strategy", async () => {
    for (const bad of ["weighted", "", 1, null, "Quota"]) {
      const req = new Request("http://localhost/api/codex-auth/pool-strategy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy: bad }),
      });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), makeCodexConfig());
      expect(resp!.status).toBe(400);
    }
  });

  test("PUT /api/codex-auth/pool-strategy rejects invalid stickyLimit", async () => {
    for (const bad of [0, 101, 1.5, "2", null, Number.NaN]) {
      const req = new Request("http://localhost/api/codex-auth/pool-strategy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stickyLimit: bad }),
      });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), makeCodexConfig());
      expect(resp!.status).toBe(400);
    }
  });

  test("PUT /api/codex-auth/pool-strategy accepts valid values and mutates runtime", async () => {
    const config = makeCodexConfig();
    const req = new Request("http://localhost/api/codex-auth/pool-strategy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy: "fill-first", stickyLimit: 7 }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    expect(resp!.status).toBe(200);
    expect(await resp!.json()).toMatchObject({
      ok: true,
      accountPoolStrategy: "fill-first",
      accountPoolStickyLimit: 7,
    });
    expect(config.accountPoolStrategy).toBe("fill-first");
    expect(config.accountPoolStickyLimit).toBe(7);
  });

  test("PATCH /api/codex-auth/pool-strategy accepts round-robin", async () => {
    const config = makeCodexConfig({ accountPoolStrategy: "quota", accountPoolStickyLimit: 1 });
    const req = new Request("http://localhost/api/codex-auth/pool-strategy", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy: "round-robin", stickyLimit: 2 }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    expect(resp!.status).toBe(200);
    expect(config.accountPoolStrategy).toBe("round-robin");
    expect(config.accountPoolStickyLimit).toBe(2);
  });

  test("PUT rejects invalid stickyLimit without mutating a valid strategy in the same body", async () => {
    const config = makeCodexConfig({ accountPoolStrategy: "quota", accountPoolStickyLimit: 1 });
    const req = new Request("http://localhost/api/codex-auth/pool-strategy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy: "fill-first", stickyLimit: 0 }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    expect(resp!.status).toBe(400);
    expect(config.accountPoolStrategy).toBe("quota");
    expect(config.accountPoolStickyLimit).toBe(1);
  });

  test("PUT /api/codex-auth/pool-strategy rejects non-object JSON bodies with 400", async () => {
    for (const raw of ["null", "[]", "\"round-robin\"", "1"]) {
      const req = new Request("http://localhost/api/codex-auth/pool-strategy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: raw,
      });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), makeCodexConfig());
      expect(resp!.status).toBe(400);
      expect(await resp!.json()).toMatchObject({ error: "body must be an object" });
    }
  });
});
describe("Anthropic account pool strategy management API", () => {
  let testDir = "";
  let previousHome: string | undefined;
  let isolatedCodexHome: IsolatedCodexHome | null = null;

  function baseConfig(): OcxConfig {
    return {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "anthropic",
      providers: {
        anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" },
        "google-antigravity": {
          adapter: "google",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          authMode: "oauth",
          googleMode: "cloud-code-assist",
        },
      },
    } as OcxConfig;
  }

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    isolatedCodexHome = installIsolatedCodexHome("ocx-pool-mgmt-codex-");
    testDir = mkdtempSync(join(tmpdir(), "ocx-pool-mgmt-"));
    process.env.OPENCODEX_HOME = testDir;
    clearGoogleAntigravityAccountPoolState();
    saveConfig(baseConfig());
    writeFileSync(join(testDir, "auth.json"), JSON.stringify({
      anthropic: {
        activeAccountId: "aaaa1111",
        accounts: [
          { id: "aaaa1111", credential: { access: "t1", refresh: "r1", expires: 9999999999999, email: "a@example.com", accountId: "acct-1" } },
        ],
      },
      "google-antigravity": {
        activeAccountId: "google-a",
        accounts: [
          { id: "google-a", credential: { access: "gt1", refresh: "gr1", expires: 9999999999999, email: "ga@example.com", accountId: "google-acct-1", projectId: "project-a" } },
          { id: "google-b", credential: { access: "gt2", refresh: "gr2", expires: 9999999999999, email: "gb@example.com", accountId: "google-acct-2", projectId: "project-b" } },
        ],
      },
    }), { mode: 0o600 });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    isolatedCodexHome?.restore();
    isolatedCodexHome = null;
    clearGoogleAntigravityAccountPoolState();
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  test("GET /api/oauth/accounts/pool surfaces strategy defaults", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/oauth/accounts/pool?provider=anthropic", server.url));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        strategy: "quota",
        stickyLimit: 1,
      });
    } finally {
      await server.stop(true);
    }
  });

  test("PUT /api/oauth/accounts/pool rejects invalid strategy", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "anthropic",
          enabled: true,
          strategy: "weighted",
        }),
      });
      expect(res.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });

  test("PUT /api/oauth/accounts/pool rejects non-object JSON bodies with 400", async () => {
    const server = startServer(0);
    try {
      for (const raw of ["null", "[]", "\"round-robin\""]) {
        const res = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: raw,
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: "body must be an object" });
      }
    } finally {
      await server.stop(true);
    }
  });

  test("PUT /api/oauth/accounts/pool rejects invalid stickyLimit", async () => {
    const server = startServer(0);
    try {
      for (const bad of [0, 101, 2.5]) {
        const res = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "anthropic",
            enabled: false,
            stickyLimit: bad,
          }),
        });
        expect(res.status).toBe(400);
      }
    } finally {
      await server.stop(true);
    }
  });

  test("PUT /api/oauth/accounts/pool accepts strategy and stickyLimit; GET reflects them", async () => {
    const server = startServer(0);
    try {
      const put = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "anthropic",
          enabled: true,
          autoSwitchThreshold: 70,
          strategy: "round-robin",
          stickyLimit: 4,
        }),
      });
      expect(put.status).toBe(200);
      expect(await put.json()).toMatchObject({
        ok: true,
        enabled: true,
        autoSwitchThreshold: 70,
        strategy: "round-robin",
        stickyLimit: 4,
      });

      const get = await fetch(new URL("/api/oauth/accounts/pool?provider=anthropic", server.url));
      expect(await get.json()).toMatchObject({
        enabled: true,
        autoSwitchThreshold: 70,
        strategy: "round-robin",
        stickyLimit: 4,
      });
    } finally {
      await server.stop(true);
    }
  });

  test("PUT without strategy fields preserves previously saved strategy", async () => {
    const server = startServer(0);
    try {
      await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "anthropic",
          enabled: true,
          strategy: "fill-first",
          stickyLimit: 9,
        }),
      });
      const put = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "anthropic",
          enabled: false,
          autoSwitchThreshold: 50,
        }),
      });
      expect(put.status).toBe(200);
      const get = await fetch(new URL("/api/oauth/accounts/pool?provider=anthropic", server.url));
      expect(await get.json()).toMatchObject({
        enabled: false,
        autoSwitchThreshold: 50,
        strategy: "fill-first",
        stickyLimit: 9,
      });
    } finally {
      await server.stop(true);
    }
  });

  test("PATCH with provider+strategy omits enabled and keeps current enabled", async () => {
    const server = startServer(0);
    try {
      await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "anthropic",
          enabled: true,
          strategy: "quota",
        }),
      });
      const patch = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "anthropic",
          strategy: "round-robin",
        }),
      });
      expect(patch.status).toBe(200);
      expect(await patch.json()).toMatchObject({
        ok: true,
        enabled: true,
        strategy: "round-robin",
      });
      const get = await fetch(new URL("/api/oauth/accounts/pool?provider=anthropic", server.url));
      expect(await get.json()).toMatchObject({
        enabled: true,
        strategy: "round-robin",
      });
    } finally {
      await server.stop(true);
    }
  });

  test("Google Antigravity pool defaults off and persists independent settings", async () => {
    const server = startServer(0);
    try {
      const initial = await fetch(new URL(
        "/api/oauth/accounts/pool?provider=google-antigravity",
        server.url,
      ));
      expect(initial.status).toBe(200);
      expect(await initial.json()).toMatchObject({
        provider: "google-antigravity",
        enabled: false,
        autoSwitchThreshold: 80,
        strategy: "quota",
        stickyLimit: 1,
      });

      const put = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "google-antigravity",
          enabled: true,
          autoSwitchThreshold: 65,
          strategy: "round-robin",
          stickyLimit: 3,
        }),
      });
      expect(put.status).toBe(200);
      expect(await put.json()).toMatchObject({
        provider: "google-antigravity",
        enabled: true,
        autoSwitchThreshold: 65,
        strategy: "round-robin",
        stickyLimit: 3,
      });

      const anthropic = await fetch(new URL(
        "/api/oauth/accounts/pool?provider=anthropic",
        server.url,
      ));
      expect(await anthropic.json()).toMatchObject({
        provider: "anthropic",
        enabled: false,
        strategy: "quota",
      });
    } finally {
      await server.stop(true);
    }
  });

  test("Cursor pool defaults off and persists independent settings", async () => {
    const server = startServer(0);
    try {
      const initial = await fetch(new URL(
        "/api/oauth/accounts/pool?provider=cursor",
        server.url,
      ));
      expect(initial.status).toBe(200);
      expect(await initial.json()).toMatchObject({
        provider: "cursor",
        enabled: false,
        autoSwitchThreshold: 80,
        strategy: "quota",
        stickyLimit: 1,
      });

      const put = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "cursor",
          enabled: true,
          autoSwitchThreshold: 60,
          strategy: "fill-first",
          stickyLimit: 2,
        }),
      });
      expect(put.status).toBe(200);
      expect(await put.json()).toMatchObject({
        provider: "cursor",
        enabled: true,
        autoSwitchThreshold: 60,
        strategy: "fill-first",
        stickyLimit: 2,
      });

      const antigravity = await fetch(new URL(
        "/api/oauth/accounts/pool?provider=google-antigravity",
        server.url,
      ));
      expect(await antigravity.json()).toMatchObject({
        provider: "google-antigravity",
        enabled: false,
      });
    } finally {
      await server.stop(true);
    }
  });

  test("Cursor import-key stores a JWT identity and never echoes the key", async () => {
    const server = startServer(0);
    try {
      const firstKey = cursorJwt("google-oauth2|cursor-a");
      const first = await fetch(new URL("/api/oauth/accounts/import-key", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "cursor", apiKey: firstKey }),
      });
      expect(first.status).toBe(200);
      const firstBody = await first.json() as Record<string, unknown>;
      expect(firstBody).toMatchObject({
        ok: true,
        provider: "cursor",
        poolEnabled: false,
      });
      expect(typeof firstBody.accountId).toBe("string");
      expect(JSON.stringify(firstBody)).not.toContain(firstKey);
      expect(JSON.stringify(firstBody)).not.toContain("apiKey");

      const pool = await fetch(new URL("/api/oauth/accounts/pool?provider=cursor", server.url));
      expect(await pool.json()).toMatchObject({ enabled: false });
    } finally {
      await server.stop(true);
    }
  });

  test("Cursor import-key auto-enables the pool on the second distinct account", async () => {
    const server = startServer(0);
    try {
      const first = await fetch(new URL("/api/oauth/accounts/import-key", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "cursor", apiKey: cursorJwt("google-oauth2|cursor-a") }),
      });
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ poolEnabled: false });

      const second = await fetch(new URL("/api/oauth/accounts/import-key", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "cursor", apiKey: cursorJwt("google-oauth2|cursor-b") }),
      });
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({ poolEnabled: true });

      const pool = await fetch(new URL("/api/oauth/accounts/pool?provider=cursor", server.url));
      expect(await pool.json()).toMatchObject({ provider: "cursor", enabled: true });

      const sameAgain = await fetch(new URL("/api/oauth/accounts/import-key", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "cursor", apiKey: cursorJwt("google-oauth2|cursor-b") }),
      });
      expect(sameAgain.status).toBe(200);
      expect(await sameAgain.json()).toMatchObject({ poolEnabled: true });
    } finally {
      await server.stop(true);
    }
  });

  test("Cursor import-key rejects non-JWT material and other providers", async () => {
    const server = startServer(0);
    try {
      const missing = await fetch(new URL("/api/oauth/accounts/import-key", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "cursor", apiKey: "not-a-jwt" }),
      });
      expect(missing.status).toBe(400);
      expect(await missing.json()).toMatchObject({
        error: "Cursor API key must be a JWT with a sub claim",
      });

      const anthropic = await fetch(new URL("/api/oauth/accounts/import-key", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", apiKey: cursorJwt("google-oauth2|nope") }),
      });
      expect(anthropic.status).toBe(400);
      expect(await anthropic.json()).toMatchObject({
        error: "import-key is only supported for cursor",
      });
    } finally {
      await server.stop(true);
    }
  });

  test("Google Antigravity clear-cooldown removes only requested cooldown", async () => {
    const poolConfig = {
      ...baseConfig(),
      googleAntigravityAccountPool: { enabled: true },
    };
    saveConfig(poolConfig);
    expect(
      rotateGoogleAntigravityAccountOn429(
        poolConfig,
        "google-a",
        "120",
        "management-session",
      ),
    ).toBe("google-b");
    expect(getGoogleAntigravityAccountHealthSnapshot("google-a")).not.toBeNull();

    const server = startServer(0);
    try {
      const response = await fetch(new URL(
        "/api/oauth/accounts/clear-cooldown",
        server.url,
      ), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "google-antigravity",
          accountId: "google-a",
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, cleared: true });
      expect(getGoogleAntigravityAccountHealthSnapshot("google-a")).toBeNull();
    } finally {
      await server.stop(true);
    }
  });

  test("Google Antigravity active selection resets routing state", async () => {
    const server = startServer(0);
    try {
      const response = await fetch(new URL(
        "/api/oauth/accounts/active",
        server.url,
      ), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "google-antigravity",
          accountId: "google-b",
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        provider: "google-antigravity",
        activeAccountId: "google-b",
      });
    } finally {
      await server.stop(true);
    }
  });
});
