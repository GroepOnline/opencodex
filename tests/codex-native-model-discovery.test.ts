import { describe, expect, test } from "bun:test";
import { discoverNativeOpenAiCatalog } from "../src/codex/catalog/native-discovery";
import { mergeCatalogEntriesForSync } from "../src/codex/catalog/sync";
import type { OcxConfig } from "../src/types";

const liveNative = {
  slug: "gpt-6.1-sol",
  display_name: "GPT-6.1 Sol",
  description: "Live native model",
  supported_reasoning_levels: [
    { effort: "high", description: "High reasoning" },
  ],
  visibility: "list",
  priority: 1,
  supported_in_api: true,
  context_window: 400_000,
  input_modalities: ["text", "image"],
};

function config(
  overrides: Pick<
    OcxConfig,
    "codexAccounts" | "activeCodexAccountId" | "codexAccountPools"
  > = {},
): OcxConfig {
  return {
    port: 10100,
    providers: {},
    defaultProvider: "openai",
    ...overrides,
  };
}

describe("live native OpenAI catalog discovery", () => {
  test("uses the explicitly selected pool account before the physical main account", async () => {
    let mainReads = 0;
    const requests: Array<{ url: string; headers: Headers }> = [];

    const result = await discoverNativeOpenAiCatalog(config({
      codexAccounts: [{ id: "pool-a", email: "a@example.test", isMain: false }],
      activeCodexAccountId: "pool-a",
    }), {
      getEffectiveActiveCodexAccountId: () => "pool-a",
      getMainAccountToken: () => {
        mainReads += 1;
        return { accessToken: "stale-main", chatgptAccountId: "stale-main-account" };
      },
      getValidCodexToken: async (id: string) => {
        expect(id).toBe("pool-a");
        return {
          accessToken: "pool-access",
          chatgptAccountId: "pool-chatgpt-account",
          generation: 1,
        };
      },
      resolveClientVersion: () => "0.160.0",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), headers: new Headers(init?.headers) });
        return new Response(JSON.stringify({ models: [liveNative] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    expect(mainReads).toBe(0);
    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (!request) throw new Error("expected one native catalog request");
    expect(request.url).toBe(
      "https://chatgpt.com/backend-api/codex/models?client_version=0.160.0",
    );
    expect(request.headers.get("authorization")).toBe("Bearer pool-access");
    expect(request.headers.get("chatgpt-account-id")).toBe("pool-chatgpt-account");
    expect(request.headers.get("originator")).toBe("codex_cli_rs");
    expect(request.headers.get("version")).toBe("0.160.0");
    expect(result.models.map(model => model.slug)).toEqual(["gpt-6.1-sol"]);
  });

  test("falls back from a dead physical main account to a usable pool credential", async () => {
    const seenAuth: string[] = [];
    const result = await discoverNativeOpenAiCatalog(config({
      codexAccounts: [{ id: "pool-b", email: "b@example.test", isMain: false }],
    }), {
      getEffectiveActiveCodexAccountId: () => undefined,
      getMainAccountToken: () => ({
        accessToken: "dead-main",
        chatgptAccountId: "dead-main-account",
      }),
      getValidCodexToken: async () => ({
        accessToken: "pool-good",
        chatgptAccountId: "pool-good-account",
        generation: 1,
      }),
      resolveClientVersion: () => "0.160.0",
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        const auth = new Headers(init?.headers).get("authorization") ?? "";
        seenAuth.push(auth);
        if (auth === "Bearer dead-main") return new Response("", { status: 401 });
        return new Response(JSON.stringify({ models: [liveNative] }), { status: 200 });
      },
    });

    expect(seenAuth).toEqual(["Bearer dead-main", "Bearer pool-good"]);
    expect(result.models.map(model => model.slug)).toEqual(["gpt-6.1-sol"]);
  });

  test("falls back when a successful response body fails while reading", async () => {
    let calls = 0;
    const result = await discoverNativeOpenAiCatalog(config({
      codexAccounts: [{ id: "pool-stream", email: "stream@example.test", isMain: false }],
    }), {
      getEffectiveActiveCodexAccountId: () => undefined,
      getMainAccountToken: () => ({
        accessToken: "main-stream-fails",
        chatgptAccountId: "main-stream-account",
      }),
      getValidCodexToken: async () => ({
        accessToken: "pool-stream-good",
        chatgptAccountId: "pool-stream-account",
        generation: 1,
      }),
      resolveClientVersion: () => "0.160.0",
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(new ReadableStream({
            start(controller) {
              controller.error(new Error("upstream body failed"));
            },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ models: [liveNative] }), { status: 200 });
      },
    });

    expect(calls).toBe(2);
    expect(result.models.map(model => model.slug)).toEqual(["gpt-6.1-sol"]);
  });

  test("does not consult pool credentials when account pools are disabled", async () => {
    let poolReads = 0;
    const result = await discoverNativeOpenAiCatalog(config({
      codexAccountPools: false,
      codexAccounts: [{ id: "pool-disabled", email: "off@example.test", isMain: false }],
      activeCodexAccountId: "pool-disabled",
    }), {
      getEffectiveActiveCodexAccountId: () => "pool-disabled",
      getMainAccountToken: () => ({
        accessToken: "dead-main",
        chatgptAccountId: "dead-main-account",
      }),
      getValidCodexToken: async () => {
        poolReads += 1;
        return {
          accessToken: "must-not-be-read",
          chatgptAccountId: "must-not-be-read",
          generation: 1,
        };
      },
      resolveClientVersion: () => "0.160.0",
      fetch: async () => new Response("", { status: 401 }),
    });

    expect(poolReads).toBe(0);
    expect(result.models).toEqual([]);
  });

  test("shares one total request deadline across account fallbacks", async () => {
    const signals: AbortSignal[] = [];
    let calls = 0;
    const result = await discoverNativeOpenAiCatalog(config({
      codexAccounts: [{ id: "pool-c", email: "c@example.test", isMain: false }],
    }), {
      getEffectiveActiveCodexAccountId: () => undefined,
      getMainAccountToken: () => ({
        accessToken: "dead-main",
        chatgptAccountId: "dead-main-account",
      }),
      getValidCodexToken: async () => ({
        accessToken: "pool-good",
        chatgptAccountId: "pool-good-account",
        generation: 1,
      }),
      resolveClientVersion: () => "0.160.0",
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (!(init?.signal instanceof AbortSignal)) {
          throw new Error("expected native catalog request deadline");
        }
        signals.push(init.signal);
        calls += 1;
        if (calls === 1) return new Response("", { status: 401 });
        return new Response(JSON.stringify({ models: [liveNative] }), { status: 200 });
      },
    });

    expect(signals).toHaveLength(2);
    expect(signals[1]).toBe(signals[0]);
    expect(result.models.map(model => model.slug)).toEqual(["gpt-6.1-sol"]);
  });

  test("authoritative live native rows survive the static native whitelist unchanged", () => {
    const result = mergeCatalogEntriesForSync(
      [liveNative],
      [],
      new Map(),
      [],
      false,
      new Set(),
      null,
      new Set(),
      new Set(),
      "default",
      new Set(),
      false,
      true,
      new Set(["gpt-6.1-sol"]),
    );

    const row = result.find(entry => entry.slug === "gpt-6.1-sol");
    expect(row).toBeDefined();
    expect(row?.display_name).toBe("GPT-6.1 Sol");
    expect(row?.supported_reasoning_levels).toEqual([
      { effort: "high", description: "High reasoning" },
    ]);
  });
});
