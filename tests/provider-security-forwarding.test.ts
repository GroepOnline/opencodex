/**
 * A provider whose secret lives in ChefVault (`credentialRef`, no inline `apiKey`) must
 * authenticate ordinary request forwarding, not just model discovery: without the lease the
 * upstream call used to leave with no Authorization header at all.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const UPSTREAM = "https://vaulted.example.test/v1/chat/completions";
const VAULT = "http://vault.test";

let testDir = "";
let previousHome: string | undefined;
let previousVaultUrl: string | undefined;
let previousVaultToken: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

const VAULT_TOKEN = "forwarding-test-bearer-token-32ch";

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousVaultUrl = process.env.CHEF_PROVIDER_SECURITY_URL;
  previousVaultToken = process.env.CHEF_PROVIDER_SECURITY_TOKEN;
  isolatedCodexHome = installIsolatedCodexHome("ocx-chefvault-fwd-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-chefvault-fwd-"));
  process.env.OPENCODEX_HOME = testDir;
  process.env.CHEF_PROVIDER_SECURITY_URL = VAULT;
  process.env.CHEF_PROVIDER_SECURITY_TOKEN = VAULT_TOKEN;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousVaultUrl === undefined) delete process.env.CHEF_PROVIDER_SECURITY_URL;
  else process.env.CHEF_PROVIDER_SECURITY_URL = previousVaultUrl;
  if (previousVaultToken === undefined) delete process.env.CHEF_PROVIDER_SECURITY_TOKEN;
  else process.env.CHEF_PROVIDER_SECURITY_TOKEN = previousVaultToken;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

function vaultedConfig(ref: string): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "vaulted",
    providers: {
      vaulted: {
        adapter: "openai-chat",
        baseUrl: "https://vaulted.example.test/v1",
        authMode: "key",
        credentialRef: ref,
      },
    },
  } as OcxConfig;
}

test("a credentialRef-only provider forwards with the leased ChefVault secret", async () => {
  const ref = "chefvault://providers/forwarding/ok";
  const originalFetch = globalThis.fetch;
  const seen: Array<string | null> = [];
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${VAULT}/v1/credentials/resolve`) {
      // The proxy must authenticate to ChefVault with the configured workload bearer;
      // an unauthenticated resolve must not mint a lease.
      if (new Headers(init?.headers).get("authorization") !== `Bearer ${VAULT_TOKEN}`) {
        return Response.json({ code: "auth_invalid", message: "credential is not recognised" }, { status: 401 });
      }
      return Response.json({
        leaseId: "lease-fwd",
        secret: "vaulted-secret-1",
        expiresAt: Date.now() + 60 * 60_000,
        fencingToken: Date.now(),
      });
    }
    if (url === UPSTREAM) {
      seen.push(new Headers(init?.headers).get("authorization"));
      return Response.json({
        id: "chatcmpl-vaulted",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  let server: ReturnType<typeof startServer> | null = null;
  try {
    saveConfig(vaultedConfig(ref));
    server = startServer(0);
    const res = await originalFetch(new URL("/v1/responses", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "vaulted/some-model", input: "hello", stream: false }),
    });

    expect(res.status).toBe(200);
    expect(seen).toEqual(["Bearer vaulted-secret-1"]);
  } finally {
    server?.stop(true);
    globalThis.fetch = originalFetch;
  }
});

test("an unresolvable credentialRef fails closed instead of forwarding unauthenticated", async () => {
  const ref = "chefvault://providers/forwarding/missing";
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${VAULT}/v1/credentials/resolve`) {
      return Response.json({ code: "ref_not_found", message: "unknown ref" }, { status: 404 });
    }
    if (url === UPSTREAM) {
      upstreamCalls += 1;
      return Response.json({ id: "chatcmpl-should-not-happen", object: "chat.completion", choices: [] });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  let server: ReturnType<typeof startServer> | null = null;
  try {
    saveConfig(vaultedConfig(ref));
    server = startServer(0);
    const res = await originalFetch(new URL("/v1/responses", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "vaulted/some-model", input: "hello", stream: false }),
    });

    expect(res.status).toBe(401);
    expect(upstreamCalls).toBe(0);
    const body = await res.text();
    expect(body).toContain("ref_not_found");
  } finally {
    server?.stop(true);
    globalThis.fetch = originalFetch;
  }
});
