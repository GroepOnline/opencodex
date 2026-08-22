/**
 * Streaming pre-commit retry (mid-stream dead-socket rescue): an upstream that dies AFTER the
 * 200 headers but before the first SSE frame surfaces as a leading adapter error. Nothing has
 * been written to the client wire yet, so handleResponses retries once on a fresh fetch for
 * plain requests; combo attempts return 502 immediately so the hop engine can cool + hop.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ProviderAdapter } from "../src/adapters/base";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "../src/types";

const actualResolver = await import("../src/server/adapter-resolve");
let adapterFactory: ((provider: OcxProviderConfig) => ProviderAdapter) | undefined;

mock.module("../src/server/adapter-resolve", () => ({
  ...actualResolver,
  resolveAdapter(provider: OcxProviderConfig, cacheRetention?: "none" | "short" | "long") {
    return adapterFactory?.(provider) ?? actualResolver.resolveAdapter(provider, cacheRetention);
  },
}));

const { handleResponses } = await import("../src/server/responses");

afterEach(() => {
  adapterFactory = undefined;
});

function config(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "fixture",
    providers: {
      fixture: {
        adapter: "test-fetch",
        baseUrl: "https://fixture.test/v1",
        authMode: "key",
        apiKey: "fixture-key",
      },
    },
  } as unknown as OcxConfig;
}

function post(comboAttempt = false): Promise<Response> {
  return handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture/model", input: "hello", stream: true }),
    }),
    config(),
    { model: "", provider: "" },
    comboAttempt ? { comboAttempt: true, providerFallbackAttempt: true } : {},
  );
}

async function collectSSE(response: Response): Promise<string> {
  return await response.text();
}

describe("streaming pre-commit retry", () => {
  test("leading error before any content retries once and streams the healthy second attempt", async () => {
    let attempts = 0;
    adapterFactory = provider => ({
      name: "test-fetch",
      buildRequest: () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "" }),
      async fetchResponse(): Promise<Response> {
        return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
      },
      async *parseStream(response: Response): AsyncGenerator<AdapterEvent> {
        attempts += 1;
        if (attempts === 1) {
          // Simulate the dead socket: the response body carries no frames at all.
          await response.text();
          yield { type: "error", message: "upstream stream ended without a terminal signal ([DONE] or finish_reason) — possible truncation" };
          return;
        }
        yield { type: "text_delta", text: "recovered" };
        yield { type: "done" };
      },
    });

    const response = await post(false);
    expect(response.status).toBe(200);
    const body = await collectSSE(response);
    expect(body).toContain("recovered");
    expect(attempts).toBe(2);
  });

  test("combo attempt returns 502 on a leading error so the hop engine owns recovery", async () => {
    let attempts = 0;
    adapterFactory = provider => ({
      name: "test-fetch",
      buildRequest: () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "" }),
      async fetchResponse(): Promise<Response> {
        return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
      },
      async *parseStream(_response: Response): AsyncGenerator<AdapterEvent> {
        attempts += 1;
        yield { type: "error", message: "upstream stream ended without a terminal signal" };
      },
    });

    const response = await post(true);
    expect(response.status).toBe(502);
    const body = await response.json() as { error?: { message?: string } };
    expect(body.error?.message ?? "").toContain("before its first event");
    expect(attempts).toBe(1);
  });

  test("committed content never retries — a late error streams through untouched", async () => {
    let attempts = 0;
    adapterFactory = provider => ({
      name: "test-fetch",
      buildRequest: () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "" }),
      async fetchResponse(): Promise<Response> {
        return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
      },
      async *parseStream(_response: Response): AsyncGenerator<AdapterEvent> {
        attempts += 1;
        yield { type: "text_delta", text: "first" };
        yield { type: "error", message: "late truncation" };
      },
    });

    const response = await post(false);
    expect(response.status).toBe(200);
    const body = await collectSSE(response);
    expect(body).toContain("first");
    expect(body).toContain("late truncation");
    expect(attempts).toBe(1);
  });
});
