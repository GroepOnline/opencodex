import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

// Full-suite Windows load: startServer + discovery GETs exceed the default 5s budget
// (same flake class as 810fa115 / claude-management-api).
setDefaultTimeout(30_000);

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-claude-discovery-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-claude-discovery-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

function configWithStaticModels(claudeCode?: OcxConfig["claudeCode"]): OcxConfig {
  return {
    port: 0,
    defaultProvider: "mock",
    openaiProviderTierVersion: 2,
    providers: {
      mock: {
        adapter: "openai-chat",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "k",
        allowPrivateNetwork: true,
        liveModels: false,
        models: ["test-model", "other-model"],
      },
    },
    ...(claudeCode ? { claudeCode } : {}),
  } as OcxConfig;
}

function configWithNativeOpenAi(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    codexAccountPools: false,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  };
}

test("anthropic-version header flips /v1/models to the discovery contract", async () => {
  saveConfig(configWithStaticModels());
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/models?limit=1000", server.url), {
      headers: { "anthropic-version": "2023-06-01", "authorization": "Bearer placeholder" },
    });
    expect(response.status).toBe(200);
    const { desktop3pAlias } = await import("../src/claude/desktop-3p");
    const json = await response.json() as { data: { id: string; display_name?: string; type?: string; created_at?: string; capabilities?: Record<string, unknown>; max_tokens?: unknown }[] };
    expect(Array.isArray(json.data)).toBe(true);
    const mockAlias = desktop3pAlias("mock", "test-model");
    const ids = json.data.map(m => m.id);
    expect(mockAlias).toMatch(/^claude-opus-4-8-[a-z][0-9a-z]{2}$/);
    expect(ids).toContain(mockAlias);
    // Every entry must satisfy the picker prefix rule (003 G3).
    for (const entry of json.data) {
      expect(entry.id.startsWith("claude") || entry.id.startsWith("anthropic")).toBe(true);
      expect(typeof entry.display_name).toBe("string");
      // Full ModelInfo contract (devlog 130 B4b): capabilities ride discovery.
      expect(entry.type).toBe("model");
      expect(entry.created_at).toBe("2026-01-01T00:00:00Z");
      expect(entry.capabilities).toBeDefined();
      expect(
        entry.max_tokens === null
        || (typeof entry.max_tokens === "number" && entry.max_tokens > 0),
      ).toBe(true);
    }
    expect(json.data.find(m => m.id === mockAlias)?.display_name).toBe("test-model (mock)");
    // Contract shape only: no OpenAI list fields on the top level.
    expect((json as Record<string, unknown>).object).toBeUndefined();
  } finally {
    server.stop(true);
  }
});

test("?flavor=anthropic works without the header; disabled -> empty data", async () => {
  saveConfig(configWithStaticModels());
  let server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/models?flavor=anthropic", server.url));
    const json = await response.json() as { data: { id: string }[] };
    const { desktop3pAlias } = await import("../src/claude/desktop-3p");
    expect(json.data.some(m => m.id === desktop3pAlias("mock", "other-model"))).toBe(true);
  } finally {
    server.stop(true);
  }

  saveConfig(configWithStaticModels({ enabled: false }));
  server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/models?flavor=anthropic", server.url));
    const json = await response.json() as { data: unknown[] };
    expect(json.data).toEqual([]);
  } finally {
    server.stop(true);
  }
});

test("per-surface id style: ?ids= wins, claude-code UA gets readable, unknown UA stays hashed (devlog 050)", async () => {
  saveConfig(configWithStaticModels());
  const server = startServer(0);
  try {
    const readable = "claude-ocx-mock--test-model";
    // 1) explicit ?ids=cli -> readable
    let json = await fetch(new URL("/v1/models?flavor=anthropic&ids=cli", server.url)).then(r => r.json()) as { data: { id: string }[] };
    expect(json.data.some(m => m.id === readable)).toBe(true);
    // 2) claude-code discovery UA -> readable
    json = await fetch(new URL("/v1/models?flavor=anthropic", server.url), {
      headers: { "user-agent": "claude-code/2.1.207 (external, cli)" },
    }).then(r => r.json()) as { data: { id: string }[] };
    expect(json.data.some(m => m.id === readable)).toBe(true);
    // 3) unknown UA -> hashed desktop family (safe default)
    json = await fetch(new URL("/v1/models?flavor=anthropic", server.url), {
      headers: { "user-agent": "Claude/1.0 (Macintosh)" },
    }).then(r => r.json()) as { data: { id: string }[] };
    expect(json.data.some(m => m.id === readable)).toBe(false);
    expect(json.data.some(m => /^claude-opus-4-8-[a-z][0-9a-z]{2}$/.test(m.id))).toBe(true);
    // 4) query beats UA: ?ids=desktop + claude-code UA -> hashed
    json = await fetch(new URL("/v1/models?flavor=anthropic&ids=desktop", server.url), {
      headers: { "user-agent": "claude-code/2.1.207 (external, cli)" },
    }).then(r => r.json()) as { data: { id: string }[] };
    expect(json.data.some(m => m.id === readable)).toBe(false);
  } finally {
    server.stop(true);
  }
});

test("live context_window reaches Claude discovery while unknown output tokens stay null", async () => {
  const upstream = Bun.serve({ port: 0, fetch: () => Response.json({ data: [
    { id: "gateway-model", context_window: 400_000, max_tokens: null },
  ] }) });
  const config = configWithStaticModels();
  config.providers.mock!.baseUrl = `${upstream.url.origin}/v1`;
  config.providers.mock!.liveModels = true;
  config.providers.mock!.models = [];
  saveConfig(config);
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/models?flavor=anthropic&ids=cli", server.url));
    expect(response.status).toBe(200);
    const json = await response.json() as { data: { id: string; max_input_tokens: number; max_tokens: unknown }[] };
    const model = json.data.find(m => m.id === "claude-ocx-mock--gateway-model");
    expect(model?.max_input_tokens).toBe(400_000);
    expect(model?.max_tokens).toBeNull();
  } finally {
    server.stop(true);
    upstream.stop(true);
  }
});

test("OpenAI list shape and Codex catalog shape stay unchanged", async () => {
  saveConfig(configWithStaticModels());
  const server = startServer(0);
  try {
    const plain = await fetch(new URL("/v1/models", server.url));
    const plainJson = await plain.json() as { object: string; data: { id: string; object: string }[] };
    expect(plainJson.object).toBe("list");
    expect(plainJson.data.some(m => m.id === "mock/test-model")).toBe(true);
    for (const m of plainJson.data) expect(m.object).toBe("model");

    const codex = await fetch(new URL("/v1/models?client_version=1.0.0", server.url), {
      // A Codex client that happens to send an anthropic-version header must still get the catalog.
      headers: { "anthropic-version": "2023-06-01" },
    });
    const codexJson = await codex.json() as { models?: unknown[]; data?: unknown };
    expect(Array.isArray(codexJson.models)).toBe(true);
    expect(codexJson.data).toBeUndefined();
  } finally {
    server.stop(true);
  }
});

test("Codex client catalog includes live native metadata for its client version", async () => {
  if (!isolatedCodexHome) throw new Error("isolated Codex home not installed");
  writeFileSync(
    join(isolatedCodexHome.path, "auth.json"),
    JSON.stringify({
      tokens: {
        access_token: "native-test-access",
        account_id: "native-test-account",
      },
    }),
    "utf8",
  );
  saveConfig(configWithNativeOpenAi());

  const server = startServer(0);
  const originalFetch = globalThis.fetch;
  let upstreamRequest: { url: string; headers: Headers } | null = null;
  const mockFetch: typeof fetch = async (input, init) => {
    const target = String(input);
    if (target.startsWith("https://chatgpt.com/backend-api/codex/models")) {
      upstreamRequest = { url: target, headers: new Headers(init?.headers) };
      return new Response(JSON.stringify({
        models: [{
          slug: "gpt-6.1-sol",
          display_name: "GPT-6.1 Sol",
          description: "Live native model",
          base_instructions: "Live native instructions.",
          shell_type: "shell_command",
          visibility: "list",
          priority: 1,
          supported_in_api: true,
          default_reasoning_level: "high",
          supported_reasoning_levels: [
            { effort: "high", description: "High reasoning" },
          ],
          context_window: 400_000,
          input_modalities: ["text", "image"],
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return originalFetch(input, init);
  };
  globalThis.fetch = mockFetch;

  try {
    const response = await originalFetch(
      new URL("/v1/models?client_version=9.9.9", server.url),
    );
    expect(response.status).toBe(200);
    const json: { models?: Array<Record<string, unknown>> } = await response.json();
    const live = json.models?.find(model => model.slug === "gpt-6.1-sol");
    expect(live?.display_name).toBe("GPT-6.1 Sol");
    expect(live?.context_window).toBe(400_000);
    expect(live?.supported_reasoning_levels).toEqual([
      { effort: "high", description: "High reasoning" },
    ]);

    if (!upstreamRequest) throw new Error("expected native upstream catalog request");
    const upstreamUrl = new URL(upstreamRequest.url);
    expect(upstreamUrl.searchParams.get("client_version")).toBe("9.9.9");
    expect(upstreamRequest.headers.get("authorization")).toBe(
      "Bearer native-test-access",
    );
    expect(upstreamRequest.headers.get("chatgpt-account-id")).toBe(
      "native-test-account",
    );
  } finally {
    globalThis.fetch = originalFetch;
    server.stop(true);
  }
});
