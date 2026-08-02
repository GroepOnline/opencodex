import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";

const previousHome = process.env.OPENCODEX_HOME;
const previousDataToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
let testHome = "";

function managementLimitedConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "0.0.0.0",
    defaultProvider: "test",
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        disabled: true,
        models: ["gpt-test"],
      },
    },
    rateLimit: {
      enabled: true,
      surfaces: {
        management: { requestsPerMinute: 1, burst: 1 },
      },
    },
  };
}

function adminHeaders(origin?: string): HeadersInit {
  return {
    "x-opencodex-api-key": "admin-secret",
    ...(origin ? { Origin: origin } : {}),
  };
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-ratelimit-management-origin-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.OPENCODEX_API_AUTH_TOKEN = "data-secret";
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "admin-secret";
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDataToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousDataToken;
  if (previousAdminToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdminToken;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = "";
});

describe("management admission origin precedence", () => {
  test("validated cross-origin admin requests stay 403 and never consume the bucket", async () => {
    saveConfig(managementLimitedConfig());
    const server = startServer(0);
    try {
      // A valid admin credential from a rejected Origin must reach the management Origin guard,
      // not consume the post-auth limiter budget.
      const rejectedBeforeExhaustion = await fetch(new URL("/api/config", server.url), {
        headers: adminHeaders("http://evil.example"),
      });
      expect(rejectedBeforeExhaustion.status).toBe(403);
      expect(await rejectedBeforeExhaustion.json()).toEqual({ error: "cross-origin request blocked" });

      // The rejected request did not charge the only token.
      const admitted = await fetch(new URL("/api/config", server.url), {
        headers: adminHeaders(),
      });
      expect(admitted.status).toBe(200);

      // The same valid principal is now genuinely exhausted.
      const exhausted = await fetch(new URL("/api/config", server.url), {
        headers: adminHeaders(),
      });
      expect(exhausted.status).toBe(429);

      // Even while exhausted, cross-origin rejection keeps its security precedence over 429.
      const rejectedAfterExhaustion = await fetch(new URL("/api/config", server.url), {
        headers: adminHeaders("http://evil.example"),
      });
      expect(rejectedAfterExhaustion.status).toBe(403);
      expect(await rejectedAfterExhaustion.json()).toEqual({ error: "cross-origin request blocked" });
    } finally {
      await server.stop(true);
    }
  });
});
