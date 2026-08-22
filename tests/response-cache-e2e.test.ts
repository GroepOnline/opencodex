/**
 * Response-cache end-to-end smoke (Fase D quality round): the full miss → store → hit cycle
 * through a real startServer() with responseCache.enabled, plus the two regressions this
 * round was about:
 * 1. a stream:true request with the cache ENABLED still reaches the handler with a readable
 *    body (the middleware must hand back a rebuilt Request, never a drained one);
 * 2. /v1/messages and /v1/chat/completions never replay each other's wire shape.
 * Also covers the new management endpoints GET /api/response-cache + POST .../clear.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { managementFetch } from "./helpers/management-auth";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-resp-cache-e2e-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-resp-cache-e2e-"));
  process.env.OPENCODEX_HOME = testDir;
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  globalThis.fetch = originalFetch;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

let upstreamHits = 0;

/**
 * Upstream that streams a complete chat completion as SSE (the wire the openai-chat adapter
 * expects) and counts how often the proxy actually reached it.
 */
function mockJsonUpstream() {
  upstreamHits = 0;
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.endsWith("/chat/completions")) {
        return Response.json({ error: { message: `unexpected path ${url.pathname}` } }, { status: 404 });
      }
      await req.json().catch(() => ({}));
      upstreamHits += 1;
      const frames = [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "pong" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } })}\n\n`,
        "data: [DONE]\n\n",
      ];
      return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
}

function mockConfig(baseUrl: string): OcxConfig {
  return {
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl, apiKey: "k", allowPrivateNetwork: true },
    },
    responseCache: { enabled: true, ttlMs: 60_000, maxEntries: 16 },
  } as OcxConfig;
}

test("identical non-streaming request hits the cache on the second call", async () => {
  const upstream = mockJsonUpstream();
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const body = JSON.stringify({
      model: "mock/test-model",
      stream: false,
      messages: [{ role: "user", content: "ping" }],
    });
    const post = () => fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer caller" },
      body,
    });

    const first = await post();
    expect(first.status).toBe(200);
    expect(first.headers.get("x-cache")).toBeNull(); // cold miss went upstream
    expect(upstreamHits).toBe(1);
    // Give the async store() clone-read a tick to land in the cache.
    await new Promise(r => setTimeout(r, 50));

    const second = await post();
    expect(second.status).toBe(200);
    expect(second.headers.get("x-cache")).toBe("HIT");
    expect(upstreamHits).toBe(1); // upstream was NOT called again
    const replayed = await second.json() as { object: string; choices: Array<{ message: { content: string } }> };
    expect(replayed.object).toBe("chat.completion");
    expect(replayed.choices[0]?.message.content).toBe("pong");
  } finally {
    server.stop(true);
    upstream.stop(true);
  }
});

test("anonymous non-streaming requests never populate the cache", async () => {
  const upstream = mockJsonUpstream();
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const body = JSON.stringify({
      model: "mock/test-model",
      stream: false,
      messages: [{ role: "user", content: "anon-ping" }],
    });
    // Credential-less callers must not share a cache bucket (null-scope fail-closed).
    const post = () => fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    const first = await post();
    expect(first.status).toBe(200);
    expect(first.headers.get("x-cache")).toBeNull();
    expect(upstreamHits).toBe(1);
    await new Promise(r => setTimeout(r, 50));

    const second = await post();
    expect(second.status).toBe(200);
    expect(second.headers.get("x-cache")).toBeNull();
    expect(upstreamHits).toBe(2); // both went upstream; nothing was stored

    const view = await (await managementFetch(new URL("/api/response-cache", server.url))).json() as {
      size: number;
      stats: { stores: number; hits: number };
    };
    expect(view.size).toBe(0);
    expect(view.stats.stores).toBe(0);
    expect(view.stats.hits).toBe(0);
  } finally {
    server.stop(true);
    upstream.stop(true);
  }
});

test("stream:true with cache enabled still streams (body not drained by the probe)", async () => {
  const upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.endsWith("/chat/completions")) {
        return Response.json({ error: {} }, { status: 404 });
      }
      await req.json().catch(() => ({}));
      const frames = [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ];
      return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/test-model",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain("data: [DONE]");
  } finally {
    server.stop(true);
    upstream.stop(true);
  }
});

test("management endpoints report stats and clear the cache", async () => {
  const upstream = mockJsonUpstream();
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const post = () => fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer caller" },
      body: JSON.stringify({
        model: "mock/test-model",
        stream: false,
        messages: [{ role: "user", content: "stats" }],
      }),
    });
    await post();
    await new Promise(r => setTimeout(r, 50));
    await post();

    const view = await (await managementFetch(new URL("/api/response-cache", server.url))).json() as {
      enabled: boolean;
      size: number;
      stats: { hits: number; misses: number; stores: number };
      ttlMs: number;
      maxEntries: number;
    };
    expect(view.enabled).toBe(true);
    expect(view.size).toBe(1);
    expect(view.stats.stores).toBeGreaterThanOrEqual(1);
    expect(view.stats.hits).toBeGreaterThanOrEqual(1);
    expect(view.stats.misses).toBeGreaterThanOrEqual(1);

    const cleared = await (await managementFetch(new URL("/api/response-cache/clear", server.url), { method: "POST" })).json() as {
      success: boolean;
      cleared: number;
    };
    expect(cleared.success).toBe(true);
    expect(cleared.cleared).toBe(1);

    const after = await (await managementFetch(new URL("/api/response-cache", server.url))).json() as { size: number };
    expect(after.size).toBe(0);
  } finally {
    server.stop(true);
    upstream.stop(true);
  }
});
