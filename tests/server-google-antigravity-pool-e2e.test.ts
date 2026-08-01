import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { clearGoogleAntigravityAccountPoolState } from "../src/oauth/google-antigravity-routing";
import { saveCredential, setActiveAccount, getAccountSet } from "../src/oauth/store";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import {
  installIsolatedCodexHome,
  type IsolatedCodexHome,
} from "./helpers/isolated-codex-home";

const PROVIDER = "google-antigravity";
let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

function config(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: PROVIDER,
    providers: {
      [PROVIDER]: {
        adapter: "google",
        baseUrl: "https://daily-cloudcode-pa.googleapis.com",
        authMode: "oauth",
        googleMode: "cloud-code-assist",
      },
    },
    googleAntigravityAccountPool: { enabled: true },
  };
}

async function seedTwoAccounts(): Promise<void> {
  await saveCredential(PROVIDER, {
    access: "token-a",
    refresh: "refresh-a",
    expires: Date.now() + 3_600_000,
    accountId: "account-a",
    projectId: "project-a",
  });
  await saveCredential(PROVIDER, {
    access: "token-b",
    refresh: "refresh-b",
    expires: Date.now() + 3_600_000,
    accountId: "account-b",
    projectId: "project-b",
  });
  const firstId = getAccountSet(PROVIDER)!.accounts[0]!.id;
  await setActiveAccount(PROVIDER, firstId);
}

function successfulAntigravityResponse(): Response {
  return new Response(JSON.stringify({
    response: {
      candidates: [{
        content: { role: "model", parts: [{ text: "ok after rotation" }] },
        finishReason: "STOP",
      }],
      usageMetadata: {
        promptTokenCount: 2,
        candidatesTokenCount: 3,
        totalTokenCount: 5,
      },
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(async () => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-antigravity-pool-e2e-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-antigravity-pool-e2e-"));
  process.env.OPENCODEX_HOME = testDir;
  clearGoogleAntigravityAccountPoolState();
  await seedTwoAccounts();
  saveConfig(config());
});

afterEach(() => {
  clearGoogleAntigravityAccountPoolState();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("server Google Antigravity account pool", () => {
  test("an explicit 429 rotates token and project while preserving session id", async () => {
    const originalFetch = globalThis.fetch;
    const attempts: Array<{
      authorization: string | null;
      project: unknown;
      sessionId: unknown;
    }> = [];
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://daily-cloudcode-pa.googleapis.com/")) {
        const envelope = JSON.parse(String(init?.body));
        attempts.push({
          authorization: new Headers(init?.headers).get("authorization"),
          project: envelope.project,
          sessionId: envelope.request?.sessionId,
        });
        if (attempts.length === 1) {
          return new Response(JSON.stringify({ error: { message: "quota exhausted" } }), {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "30",
            },
          });
        }
        return successfulAntigravityResponse();
      }
      return originalFetch(input, init);
    };

    const server = startServer(0);
    try {
      const response = await originalFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "google-antigravity/gemini-3.1-pro",
          input: "keep this session stable",
          stream: false,
        }),
      });
      expect(response.status).toBe(200);
      expect(attempts).toHaveLength(2);
      expect(attempts.map(attempt => attempt.authorization)).toEqual([
        "Bearer token-a",
        "Bearer token-b",
      ]);
      expect(attempts.map(attempt => attempt.project)).toEqual([
        "project-a",
        "project-b",
      ]);
      expect(attempts[0]!.sessionId).toBe(attempts[1]!.sessionId);
    } finally {
      server.stop(true);
      globalThis.fetch = originalFetch;
    }
  });

  test("400 and 502 responses never rotate accounts", async () => {
    const originalFetch = globalThis.fetch;
    const attempts: string[] = [];
    let upstreamStatus = 400;
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://daily-cloudcode-pa.googleapis.com/")) {
        attempts.push(new Headers(init?.headers).get("authorization") ?? "");
        return new Response(JSON.stringify({ error: { message: "not a quota error" } }), {
          status: upstreamStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input, init);
    };

    const server = startServer(0);
    try {
      for (const status of [400, 502]) {
        upstreamStatus = status;
        attempts.length = 0;
        const response = await originalFetch(new URL("/v1/responses", server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "google-antigravity/gemini-3.1-pro",
            input: `status ${status}`,
            stream: false,
          }),
        });
        expect(response.status).toBe(status);
        expect(attempts.length).toBeGreaterThan(0);
        expect(attempts.every(auth => auth === "Bearer token-a")).toBe(true);
      }
    } finally {
      server.stop(true);
      globalThis.fetch = originalFetch;
    }
  });

  test("stops after the shared 3-attempt budget even when more accounts are eligible", async () => {
    for (const suffix of ["c", "d", "e"]) {
      await saveCredential(PROVIDER, {
        access: `token-${suffix}`,
        refresh: `refresh-${suffix}`,
        expires: Date.now() + 3_600_000,
        accountId: `account-${suffix}`,
        projectId: `project-${suffix}`,
      });
    }
    const firstId = getAccountSet(PROVIDER)!.accounts[0]!.id;
    await setActiveAccount(PROVIDER, firstId);

    const originalFetch = globalThis.fetch;
    const attempts: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://daily-cloudcode-pa.googleapis.com/")) {
        attempts.push(new Headers(init?.headers).get("authorization") ?? "");
        return new Response(JSON.stringify({ error: { message: "quota exhausted" } }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "30",
          },
        });
      }
      return originalFetch(input, init);
    };

    const server = startServer(0);
    try {
      const response = await originalFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "google-antigravity/gemini-3.1-pro",
          input: "bounded failover",
          stream: false,
        }),
      });
      expect(response.status).toBe(429);
      expect(attempts).toHaveLength(3);
      expect(new Set(attempts).size).toBe(3);
    } finally {
      server.stop(true);
      globalThis.fetch = originalFetch;
    }
  });

  test("context-overflow 429 never cools or rotates Antigravity accounts", async () => {
    const originalFetch = globalThis.fetch;
    const attempts: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://daily-cloudcode-pa.googleapis.com/")) {
        attempts.push(new Headers(init?.headers).get("authorization") ?? "");
        return new Response(JSON.stringify({
          error: {
            message: "RESOURCE_EXHAUSTED: Your input exceeds the context window of this model",
          },
        }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "30",
          },
        });
      }
      return originalFetch(input, init);
    };

    const server = startServer(0);
    try {
      const response = await originalFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "google-antigravity/gemini-3.1-pro",
          input: "overflow must not cool",
          stream: false,
        }),
      });
      expect(response.status).toBe(429);
      expect(attempts).toEqual(["Bearer token-a"]);
      const { getGoogleAntigravityAccountHealthSnapshot } = await import(
        "../src/oauth/google-antigravity-routing"
      );
      const firstId = getAccountSet(PROVIDER)!.accounts[0]!.id;
      expect(getGoogleAntigravityAccountHealthSnapshot(firstId)).toBeNull();
    } finally {
      server.stop(true);
      globalThis.fetch = originalFetch;
    }
  });
});
