/**
 * Request-path upstream body reads are bounded: a huge passthrough error body is
 * cut off at the error-body cap, and an oversized non-streaming success JSON
 * becomes a defined 502 instead of being buffered without limit.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { clearAccountNeedsReauth, clearAccountQuota, updateAccountQuota } from "../src/codex/auth-api";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../src/codex/routing";
import { saveConfig } from "../src/config";
import { BOUNDED_BODY_MAX_BYTES, UPSTREAM_SUCCESS_BODY_MAX_BYTES } from "../src/lib/bounded-body";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const originalGlobalFetch = globalThis.fetch;
const TEST_DIR = join(import.meta.dir, ".tmp-bounded-upstream-body-passthrough");
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  isolatedCodexHome = installIsolatedCodexHome("ocx-bounded-upstream-body-");
});

afterEach(() => {
  globalThis.fetch = originalGlobalFetch;
  if (previousApiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiToken;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountNeedsReauth("pool-a");
  clearAccountQuota();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

/**
 * In-process upstream body that re-enqueues one shared chunk, so a large logical
 * body costs one chunk of memory. `pulls` records how much the proxy consumed.
 */
function countingUpstreamBody(chunk: Uint8Array, count: number, counter: { pulls: number }) {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= count) {
        controller.close();
        return;
      }
      sent++;
      counter.pulls++;
      controller.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
}

async function withPoolPassthrough(
  reply: () => Response,
  run: (serverUrl: string) => Promise<void>,
): Promise<void> {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountQuota();
  clearAccountNeedsReauth("pool-a");

  // Answer the canonical Codex backend in-process so the test controls the
  // upstream body stream directly.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/codex")) {
      return Promise.resolve(reply());
    }
    return originalGlobalFetch(input, init);
  }) as typeof fetch;

  saveConfig({
    port: 0,
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    codexAccounts: [
      { id: "main", email: "main@example.test", isMain: true },
      { id: "pool-a", email: "pool-a@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
    ],
    activeCodexAccountId: "pool-a",
  } as OcxConfig);
  saveCodexAccountCredential("pool-a", {
    accessToken: "pool-a-token",
    refreshToken: "pool-a-refresh",
    expiresAt: Date.now() + 10 * 60_000,
    chatgptAccountId: "acct-pool-a",
  });
  updateAccountQuota("pool-a", 10);

  const server = startServer(0);
  try {
    await run(server.url.toString());
  } finally {
    await server.stop(true);
  }
}

async function postResponses(serverUrl: string): Promise<Response> {
  return originalGlobalFetch(new URL("/v1/responses", serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer inbound-token" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "hi", stream: false }),
  });
}

describe("bounded upstream body reads on the passthrough path", () => {
  test("an error body larger than the cap is cut off, not buffered in full", async () => {
    const counter = { pulls: 0 };
    const chunk = new Uint8Array(16 * 1024).fill(0x61);
    const totalChunks = 256; // 4 MiB logical error body
    await withPoolPassthrough(
      () => new Response(countingUpstreamBody(chunk, totalChunks, counter), {
        status: 400,
        headers: { "content-type": "text/plain" },
      }),
      async (serverUrl) => {
        const response = await postResponses(serverUrl);
        expect(response.status).toBe(400);
        expect(response.headers.get("content-type")).toContain("application/json");
        const text = await response.text();
        expect(text.length).toBeLessThan(BOUNDED_BODY_MAX_BYTES);
        const json = JSON.parse(text) as { error?: { message?: string } };
        expect(json.error?.message).toContain("400");
      },
    );
    // The proxy stops near the 64 KiB error cap (plus small peek/read-ahead),
    // far short of the full body.
    expect(counter.pulls).toBeGreaterThan(0);
    expect(counter.pulls).toBeLessThanOrEqual(16);
  });

  test("an oversized non-streaming success JSON becomes a 502 upstream error", async () => {
    const counter = { pulls: 0 };
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    const totalChunks = UPSTREAM_SUCCESS_BODY_MAX_BYTES / chunk.byteLength + 16;
    await withPoolPassthrough(
      () => new Response(countingUpstreamBody(chunk, totalChunks, counter), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      async (serverUrl) => {
        const response = await postResponses(serverUrl);
        expect(response.status).toBe(502);
        const json = await response.json() as { error?: { message?: string; type?: string } };
        expect(json.error?.message).toContain("exceeded");
        expect(json.error?.message).toContain(String(UPSTREAM_SUCCESS_BODY_MAX_BYTES));
      },
    );
    expect(counter.pulls).toBeLessThan(totalChunks);
  });
});
