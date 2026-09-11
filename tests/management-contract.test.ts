import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig, CONFIG_SCHEMA_VERSION } from "../src/config";
import { MANAGEMENT_CONTRACT_VERSION } from "../src/server/contract-version";
import {
  resetBuildInfoCacheForTests,
  setBuildInfoForTests,
} from "../src/server/build-provenance";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";

const previousHome = process.env.OPENCODEX_HOME;
const previousDataToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
let testHome = "";

function remoteConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "demo",
    providers: {
      demo: {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        apiKey: "sk-test",
        models: ["gpt-test"],
      },
    },
  };
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-management-contract-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.OPENCODEX_API_AUTH_TOKEN = "data-secret";
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "admin-secret";
  writeFileSync(join(testHome, "usage.jsonl"), "", "utf8");
  setBuildInfoForTests({
    git_sha: "abc123def456",
    built_at: "2026-08-23T10:00:00.000Z",
    release: "v1.2.2",
    gui_version: "1.2.2",
  });
});

afterEach(() => {
  resetBuildInfoCacheForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDataToken === undefined)
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousDataToken;
  if (previousAdminToken === undefined)
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdminToken;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = "";
});

describe("GET /api/provenance", () => {
  test("returns deploy-gate-safe identity without management auth", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/provenance", server.url));
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.contract_version).toBe(MANAGEMENT_CONTRACT_VERSION);
      expect(body.version).toBeTruthy();
      expect(body.git_sha).toBe("abc123def456");
      expect(body.built_at).toBe("2026-08-23T10:00:00.000Z");
      expect(body.release).toBe("v1.2.2");
      expect(body.gui_version).toBe("1.2.2");
      // saveConfig stamps schemaVersion; public provenance must echo that stamp.
      expect(body.schema_version).toBe(String(CONFIG_SCHEMA_VERSION));
      expect(body.management).toBeUndefined();
      expect(body.runtime).toMatchObject({
        service: "opencodex",
        platform: process.platform,
      });
    } finally {
      await server.stop(true);
    }
  });

  test("adds management block when called with management auth", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/provenance", server.url), {
        headers: { "x-opencodex-api-key": "admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        management?: Record<string, unknown>;
      };
      expect(body.management).toMatchObject({
        contract_version: MANAGEMENT_CONTRACT_VERSION,
        default_provider: "demo",
        provider_count: 1,
        management_auth_available: true,
      });
    } finally {
      await server.stop(true);
    }
  });
});

describe("GET /api/health", () => {
  test("returns causality-rich health contract behind management auth", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const unauthenticated = await fetch(new URL("/api/health", server.url));
      expect(unauthenticated.status).toBe(401);

      const res = await fetch(new URL("/api/health", server.url), {
        headers: { "x-opencodex-api-key": "admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        checked_at: string;
        contract_version: string;
        components: {
          proxy: { status: string };
          management_api: { status: string };
          persistence: { status: string };
          providers: Array<{ name: string; status: string }>;
          deploy_runner: { status: string };
        };
        causality: unknown[];
      };
      expect(body.contract_version).toBe(MANAGEMENT_CONTRACT_VERSION);
      expect(body.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(body.components.proxy.status).toBe("ok");
      expect(body.components.management_api.status).toBe("ok");
      expect(body.components.persistence.status).toBe("ok");
      expect(body.components.providers[0]).toMatchObject({
        name: "demo",
        status: "ok",
      });
      expect(body.components.deploy_runner.status).toBe("unknown");
      expect(Array.isArray(body.causality)).toBe(true);
    } finally {
      await server.stop(true);
    }
  });
});

describe("capability matrix — EXISTS", () => {
  test("Providers Read GET /api/providers", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/providers", server.url), {
        headers: { "x-opencodex-api-key": "admin-secret" },
      });
      expect(res.status).toBe(200);
      const rows = (await res.json()) as Array<{ name: string }>;
      expect(rows.some((row) => row.name === "demo")).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("Providers Create POST /api/providers", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: {
          "x-opencodex-api-key": "admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "added",
          provider: {
            adapter: "openai-chat",
            baseUrl: "https://example.test/v1",
            apiKey: "sk-added",
            models: ["gpt-added"],
          },
        }),
      });
      expect(res.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("Providers Update PATCH /api/providers", async () => {
    saveConfig({
      ...remoteConfig(),
      providers: {
        ...remoteConfig().providers,
        spare: {
          adapter: "openai-chat",
          baseUrl: "https://example.test/v1",
          apiKey: "sk-spare",
          models: ["gpt-spare"],
        },
      },
    });
    const server = startServer(0);
    try {
      const res = await fetch(
        new URL("/api/providers?name=spare", server.url),
        {
          method: "PATCH",
          headers: {
            "x-opencodex-api-key": "admin-secret",
            "content-type": "application/json",
          },
          body: JSON.stringify({ disabled: true }),
        },
      );
      expect(res.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("Providers Delete DELETE /api/providers", async () => {
    saveConfig({
      ...remoteConfig(),
      providers: {
        ...remoteConfig().providers,
        spare: {
          adapter: "openai-chat",
          baseUrl: "https://example.test/v1",
          apiKey: "sk-spare",
          models: ["gpt-spare"],
        },
      },
    });
    const server = startServer(0);
    try {
      const res = await fetch(
        new URL("/api/providers?name=spare", server.url),
        {
          method: "DELETE",
          headers: { "x-opencodex-api-key": "admin-secret" },
        },
      );
      expect(res.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("Providers Test POST /api/providers/test", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const res = await fetch(
        new URL("/api/providers/test?name=demo", server.url),
        {
          method: "POST",
          headers: { "x-opencodex-api-key": "admin-secret" },
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(typeof body.ok).toBe("boolean");
    } finally {
      await server.stop(true);
    }
  });

  test("Providers Health GET /api/provider-quotas", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const res = await fetch(
        new URL("/api/provider-quotas?provider=demo", server.url),
        {
          headers: { "x-opencodex-api-key": "admin-secret" },
        },
      );
      expect(res.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("OAuth accounts Read GET /api/oauth/accounts", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const res = await fetch(
        new URL("/api/oauth/accounts?provider=xai", server.url),
        {
          headers: { "x-opencodex-api-key": "admin-secret" },
        },
      );
      expect(res.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("Models Read GET /api/models", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/models", server.url), {
        headers: { "x-opencodex-api-key": "admin-secret" },
      });
      expect(res.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("Models Update PUT /api/disabled-models", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/disabled-models", server.url), {
        method: "PUT",
        headers: {
          "x-opencodex-api-key": "admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ models: [] }),
      });
      expect(res.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("Usage Read GET /api/usage", async () => {
    saveConfig(remoteConfig());
    writeFileSync(join(testHome, "usage.jsonl"), "", "utf8");
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/usage?range=7d", server.url), {
        headers: { "x-opencodex-api-key": "admin-secret" },
      });
      expect(res.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("Requests Read GET /api/logs", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/logs", server.url), {
        headers: { "x-opencodex-api-key": "admin-secret" },
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("Runtime Read GET /api/config", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/config", server.url), {
        headers: { "x-opencodex-api-key": "admin-secret" },
      });
      expect(res.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("Runtime limited Update PUT /api/settings", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/settings", server.url), {
        method: "PUT",
        headers: {
          "x-opencodex-api-key": "admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ codexAutoStart: false }),
      });
      expect(res.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("Runtime Health GET /api/startup-health", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/startup-health", server.url), {
        headers: { "x-opencodex-api-key": "admin-secret" },
      });
      expect(res.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });
});

describe("capability matrix — MISSING placeholders", () => {
  test.skip("Accounts Create POST /api/codex-auth/accounts requires OPENCODEX_ALLOW_UNVERIFIED_CODEX_IMPORT", () => {
    /* guarded import path — CLI/GUI use OAuth login instead */
  });

  test.skip("Accounts Test dedicated /api/codex-auth/test endpoint", () => {
    /* use login-status polling + quota reads instead */
  });

  test.skip("OAuth accounts Test dedicated /api/oauth/accounts/test endpoint", () => {
    /* login/status flow is the test surface */
  });

  test.skip("Pools Test dedicated pool probe endpoint", () => {
    /* quota + provider-quotas are the partial health surface */
  });

  test.skip("Models Test dedicated /api/models/test endpoint", () => {
    /* POST /api/providers/models/refresh is the partial test surface */
  });

  test.skip("Usage Health dedicated /api/usage/health endpoint", () => {
    /* usage read + persistence health cover partial observability */
  });

  test.skip("Requests Health dedicated /api/logs/health endpoint", () => {
    /* ring buffer + usage.jsonl hydration — no dedicated health route */
  });

  test.skip("Requests Replay POST /api/logs/replay", () => {
    /* optional future capability */
  });

  test.skip("Runtime Test dedicated /api/runtime/test endpoint", () => {
    /* startup-health + system/memory are partial runtime test surfaces */
  });
});
