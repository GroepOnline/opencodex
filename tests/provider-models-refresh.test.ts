import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleManagementAPI } from "../src/server/management-api";
import { saveConfig } from "../src/config";
import {
  clearModelCache,
  markModelsFetchFailure,
  setCached,
} from "../src/codex/model-cache";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import { ManagementRequest as Request } from "./helpers/management-auth";

const TEST_DIR = join(tmpdir(), "ocx-provider-models-refresh-test");
const previousHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  clearModelCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function liveChat(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "sk-x",
    allowPrivateNetwork: true,
    ...overrides,
  };
}

function baseConfig(providers: OcxConfig["providers"]): OcxConfig {
  if (globalThis.fetch !== originalFetch) {
    for (const provider of Object.values(providers)) {
      (provider as typeof provider & { fetch?: typeof fetch }).fetch = globalThis.fetch;
    }
  }
  const config = {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: Object.keys(providers)[0]!,
    providers,
  } as OcxConfig;
  saveConfig(config);
  return config;
}

async function refresh(
  config: OcxConfig,
  name: string,
): Promise<{ status: number; body: Record<string, unknown>; catalogRefreshCount: number }> {
  let catalogRefreshCount = 0;
  const req = new Request(
    `http://127.0.0.1/api/providers/models/refresh?name=${encodeURIComponent(name)}`,
    { method: "POST" },
  );
  const res = await handleManagementAPI(req, new URL(req.url), config, {
    refreshCodexCatalog: async () => {
      catalogRefreshCount += 1;
    },
  });
  if (!res) throw new Error("handler returned no response");
  return { status: res.status, body: await res.json() as Record<string, unknown>, catalogRefreshCount };
}

describe("POST /api/providers/models/refresh", () => {
  test("unknown provider is 404", async () => {
    const config = baseConfig({ live: liveChat() });
    const { status, body } = await refresh(config, "missing");
    expect(status).toBe(404);
    expect(body.error).toBe("unknown provider");
  });

  test("disabled provider does not hit upstream", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response(JSON.stringify({ data: [{ id: "nope" }] }), { status: 200 });
    }) as typeof fetch;
    const config = baseConfig({ live: liveChat({ disabled: true }) });
    const { status, body, catalogRefreshCount } = await refresh(config, "live");
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Provider is disabled");
    expect(fetches).toBe(0);
    expect(catalogRefreshCount).toBe(0);
  });

  test("passthrough providers return an empty catalog without fetching", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response(JSON.stringify({ data: [{ id: "nope" }] }), { status: 200 });
    }) as typeof fetch;
    const config = baseConfig({
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
    });
    const { body, catalogRefreshCount } = await refresh(config, "openai");
    expect(body.ok).toBe(true);
    expect(body.source).toBe("passthrough");
    expect(body.models).toEqual([]);
    expect(fetches).toBe(0);
    expect(catalogRefreshCount).toBe(0);
  });

  test("fetches live /models and resyncs the Codex catalog", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response(JSON.stringify({
        data: [{ id: "alpha" }, { id: "beta" }],
      }), { status: 200 });
    }) as typeof fetch;
    const config = baseConfig({ live: liveChat() });
    const { status, body, catalogRefreshCount } = await refresh(config, "live");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.source).toBe("live");
    expect(body.count).toBe(2);
    expect(body.models).toEqual(["alpha", "beta"]);
    expect(fetches).toBeGreaterThan(0);
    expect(catalogRefreshCount).toBe(1);
  });

  test("bypasses a fresh cache and discovery cooldown", async () => {
    setCached("live", [{ id: "stale", provider: "live" }]);
    markModelsFetchFailure("live");
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response(JSON.stringify({ data: [{ id: "fresh" }] }), { status: 200 });
    }) as typeof fetch;
    const config = baseConfig({ live: liveChat({ models: ["stale"] }) });
    const { body } = await refresh(config, "live");
    expect(body.ok).toBe(true);
    expect(body.models).toEqual(["fresh"]);
    expect(fetches).toBeGreaterThan(0);
  });

  test("failed live discovery returns ok:false with the configured fallback", async () => {
    globalThis.fetch = (async () => new Response("upstream down", { status: 503 })) as typeof fetch;
    const config = baseConfig({ live: liveChat({ models: ["fallback-id"] }) });
    const { body } = await refresh(config, "live");
    expect(body.ok).toBe(false);
    expect(body.source).toBe("stale");
    expect(body.models).toEqual(["fallback-id"]);
    expect(String(body.error)).toContain("503");
  });

  test("static catalog providers do not hit upstream", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response("nope", { status: 500 });
    }) as typeof fetch;
    const config = baseConfig({
      frozen: liveChat({ liveModels: false, models: ["only-configured"] }),
    });
    const { body, catalogRefreshCount } = await refresh(config, "frozen");
    expect(body.ok).toBe(true);
    expect(body.source).toBe("static");
    expect(body.models).toEqual(["only-configured"]);
    expect(fetches).toBe(0);
    expect(catalogRefreshCount).toBe(1);
  });
});
