import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { managementFetch } from "./helpers/management-auth";

const FIXTURE_KEY = "INFERENCE_GATEWAY_API_KEY_FIXTURE";

const previousHome = process.env.OPENCODEX_HOME;
const previousDataToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
const previousDesktopConfigDir = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
let testHome = "";

function loopbackConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "mock",
    providers: {
      mock: {
        adapter: "openai-chat",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "k",
        allowPrivateNetwork: true,
        liveModels: false,
        models: ["test-model"],
      },
    },
  };
}

function writeAppliedLibrary(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "_meta.json"), JSON.stringify({
    appliedId: "opencodex-fixture",
    entries: [{ id: "opencodex-fixture", name: "opencodex" }],
  }));
  writeFileSync(join(dir, "opencodex-fixture.json"), JSON.stringify({
    inferenceProvider: "gateway",
    inferenceGatewayApiKey: FIXTURE_KEY,
  }));
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-3p-lib-auth-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.OPENCODEX_API_AUTH_TOKEN = FIXTURE_KEY;
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "admin-secret";
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(testHome, "claude-desktop");
  writeAppliedLibrary(process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR);
  saveConfig(loopbackConfig());
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDataToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousDataToken;
  if (previousAdminToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdminToken;
  if (previousDesktopConfigDir === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = previousDesktopConfigDir;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = "";
});

describe("Claude Desktop 3P library HTTP auth", () => {
  test("loopback GET /v1/claude-desktop-3p-library without a key returns 401", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/claude-desktop-3p-library", server.url));
      expect(res.status).toBe(401);
      const body = await res.text();
      expect(body).not.toContain(FIXTURE_KEY);
    } finally {
      await server.stop(true);
    }
  });

  test("authenticated loopback GET /v1/claude-desktop-3p-library returns 200 with fixture config", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/claude-desktop-3p-library", server.url), {
        headers: { "x-opencodex-api-key": FIXTURE_KEY },
      });
      expect(res.status).toBe(200);
      const payload = await res.json() as { ok: boolean; config: { inferenceGatewayApiKey: string } };
      expect(payload.ok).toBe(true);
      expect(payload.config.inferenceGatewayApiKey).toBe(FIXTURE_KEY);
    } finally {
      await server.stop(true);
    }
  });

  test("management GET /api/claude-desktop/3p-library requires admin token", async () => {
    const server = startServer(0);
    try {
      const unauth = await fetch(new URL("/api/claude-desktop/3p-library", server.url));
      expect(unauth.status).toBe(401);
      expect(await unauth.text()).not.toContain(FIXTURE_KEY);

      const authed = await managementFetch(new URL("/api/claude-desktop/3p-library", server.url));
      expect(authed.status).toBe(200);
      const payload = await authed.json() as { ok: boolean; config: { inferenceGatewayApiKey: string } };
      expect(payload.ok).toBe(true);
      expect(payload.config.inferenceGatewayApiKey).toBe(FIXTURE_KEY);
    } finally {
      await server.stop(true);
    }
  });
});
