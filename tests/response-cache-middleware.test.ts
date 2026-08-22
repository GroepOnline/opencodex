/**
 * Response-cache middleware (Fase D): probe logic for non-streaming routes.
 * Covers: cache disabled → null, streaming opts out but still yields a re-readable body,
 * stable key order collapses, hit returns a rebuilt Response with x-cache: HIT, miss stores
 * a 2xx body. The key invariant: a probe that has consumed the body MUST hand the downstream
 * handler a rebuilt Request (never bare null with a drained stream).
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  installResponseCache,
  probeResponseCache,
  getInstalledCache,
  clearResponseCache,
} from "../src/cache/response-cache-middleware";
import type { OcxConfig } from "../src/types";

function baseConfig(): OcxConfig {
  // Minimal config: only what routeModel + the probe need. Cast to satisfy the
  // broad OcxConfig type without dragging the whole default config in.
  return {
    port: 10100,
    defaultProvider: "anthropic",
    providers: {
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        models: ["claude-opus-4-8"],
      } as unknown as OcxConfig["providers"]["anthropic"],
    },
  } as unknown as OcxConfig;
}

function makeReq(body: unknown, opts: {
  stream?: boolean;
  cacheControl?: string;
  endpoint?: "responses" | "messages" | "chat-completions";
  authorization?: string;
  accountId?: string;
  signal?: AbortSignal;
} = {}): Request {
  const payload = { ...(typeof body === "string" ? JSON.parse(body) : body) };
  if (opts.stream) payload.stream = true;
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.cacheControl) headers.set("cache-control", opts.cacheControl);
  if (opts.authorization) headers.set("authorization", opts.authorization);
  if (opts.accountId) headers.set("chatgpt-account-id", opts.accountId);
  return new Request(`http://localhost${opts.endpoint === "responses" ? "/v1/responses" : opts.endpoint === "chat-completions" ? "/v1/chat/completions" : "/v1/messages"}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: opts.signal,
  });
}

describe("probeResponseCache", () => {
  beforeEach(() => {
    clearResponseCache();
  });
  afterEach(() => {
    getInstalledCache()?.stopSweep();
  });

  test("returns null when cache is disabled", async () => {
    installResponseCache({ port: 10100, providers: {} } as unknown as OcxConfig);
    const req = makeReq({ model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }] });
    expect(await probeResponseCache(req, baseConfig(), "messages")).toBeNull();
  });

  test("streaming request opts out but STILL yields a rebuilt request (no drained body)", async () => {
    installResponseCache({ port: 10100, providers: {}, responseCache: { enabled: true } } as unknown as OcxConfig);
    const req = makeReq({ model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }] }, { stream: true });
    const probe = await probeResponseCache(req, baseConfig(), "messages");
    // Must NOT be null: the body was consumed, so the downstream handler needs a rebuilt Request.
    expect(probe).not.toBeNull();
    expect("miss" in probe!).toBe(true);
    const reread = await (probe as { request: Request }).request.text();
    expect(JSON.parse(reread).stream).toBe(true);
    // Nothing is stored for a streaming request.
    (probe as { store: (r: Response) => void }).store(new Response("stream", { status: 200, headers: { "content-type": "text/event-stream" } }));
    await new Promise(r => setTimeout(r, 0));
    expect(getInstalledCache()!.size).toBe(0);
  });

  test("rebuilt streaming request preserves client cancellation", async () => {
    installResponseCache({ port: 10100, providers: {}, responseCache: { enabled: true } } as unknown as OcxConfig);
    const controller = new AbortController();
    const req = makeReq(
      { model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }] },
      { stream: true, signal: controller.signal },
    );
    const probe = await probeResponseCache(req, baseConfig(), "messages");
    expect(probe).not.toBeNull();
    expect("miss" in probe!).toBe(true);
    controller.abort();
    expect((probe as { request: Request }).request.signal.aborted).toBe(true);
  });

  test("caller identity is part of the cache scope", async () => {
    installResponseCache({ port: 10100, providers: {}, responseCache: { enabled: true, ttlMs: 10_000 } } as unknown as OcxConfig);
    const body = { model: "claude-opus-4-8", messages: [{ role: "user", content: "private" }] };
    const first = await probeResponseCache(makeReq(body, { authorization: "Bearer caller-a" }), baseConfig(), "messages");
    expect(first && "store" in first).toBe(true);
    if (first && "store" in first) {
      first.store(new Response(JSON.stringify({ completion: "caller-a-only" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
      await new Promise(r => setTimeout(r, 0));
    }

    const otherCaller = await probeResponseCache(
      makeReq(body, { authorization: "Bearer caller-b" }),
      baseConfig(),
      "messages",
    );
    expect(otherCaller && "hit" in otherCaller).toBe(false);

    const sameCaller = await probeResponseCache(
      makeReq(body, { authorization: "Bearer caller-a" }),
      baseConfig(),
      "messages",
    );
    expect(sameCaller && "hit" in sameCaller).toBe(true);
  });

  test("anonymous requests never cache (null-scope fail-closed)", async () => {
    installResponseCache({ port: 10100, providers: {}, responseCache: { enabled: true, ttlMs: 10_000 } } as unknown as OcxConfig);
    const body = { model: "claude-opus-4-8", messages: [{ role: "user", content: "anon" }] };
    // No authorization / account / session headers → null caller scope.
    const first = await probeResponseCache(makeReq(body), baseConfig(), "messages");
    expect(first).not.toBeNull();
    expect("miss" in first!).toBe(true);
    if (first && "store" in first) {
      first.store(new Response(JSON.stringify({ completion: "should-not-persist" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
      await new Promise(r => setTimeout(r, 0));
    }
    expect(getInstalledCache()!.size).toBe(0);

    const second = await probeResponseCache(makeReq(body), baseConfig(), "messages");
    expect(second && "hit" in second).toBe(false);
    expect(getInstalledCache()!.size).toBe(0);
  });

  test("returns null when client sends cache-control: no-store (fast path, body untouched)", async () => {
    installResponseCache({ port: 10100, providers: {}, responseCache: { enabled: true } } as unknown as OcxConfig);
    const req = makeReq(
      { model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }] },
      { cacheControl: "no-store" },
    );
    expect(await probeResponseCache(req, baseConfig(), "messages")).toBeNull();
  });

  test("stable key order collapses into a hit on the second call", async () => {
    installResponseCache({ port: 10100, providers: {}, responseCache: { enabled: true, ttlMs: 10_000 } } as unknown as OcxConfig);

    const body = { model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }] };
    const a = makeReq({ ...body, z: 1, a: 2 }, { authorization: "Bearer caller" });
    const b = makeReq({ ...body, a: 2, z: 1 }, { authorization: "Bearer caller" }); // different key order, same semantics

    const probeA = await probeResponseCache(a, baseConfig(), "messages");
    expect(probeA).not.toBeNull();
    expect("hit" in probeA!).toBe(false); // miss
    if ("store" in probeA!) {
      probeA.store(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
      await new Promise(r => setTimeout(r, 0)); // store() resolves asynchronously
    }

    const probeB = await probeResponseCache(b, baseConfig(), "messages");
    expect(probeB).not.toBeNull();
    expect("hit" in probeB!).toBe(true); // stable order → same key → HIT
  });

  test("miss exposes a rebuilt request + store that captures a 2xx body", async () => {
    installResponseCache({ port: 10100, providers: {}, responseCache: { enabled: true, ttlMs: 10_000 } } as unknown as OcxConfig);
    const req = makeReq({ model: "claude-opus-4-8", messages: [{ role: "user", content: "ping" }] }, { authorization: "Bearer caller" });
    const probe = await probeResponseCache(req, baseConfig(), "messages");
    expect(probe).not.toBeNull();
    if ("miss" in probe!) {
      // The rebuilt request must carry a re-readable body.
      const reread = await probe.request.text();
      expect(JSON.parse(reread).model).toBe("claude-opus-4-8");
      // A 2xx non-stream body is stored.
      probe.store(new Response(JSON.stringify({ completion: "pong" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
      await new Promise(r => setTimeout(r, 0)); // store() resolves asynchronously
      expect(getInstalledCache()!.size).toBe(1);
    }
  });

  test("store ignores non-2xx and event-stream responses", async () => {
    installResponseCache({ port: 10100, providers: {}, responseCache: { enabled: true, ttlMs: 10_000 } } as unknown as OcxConfig);
    const req = makeReq({ model: "claude-opus-4-8", messages: [{ role: "user", content: "x" }] }, { authorization: "Bearer caller" });
    const probe = await probeResponseCache(req, baseConfig(), "messages");
    if ("store" in probe!) {
      probe.store(new Response("rate limited", { status: 429, headers: { "content-type": "application/json" } }));
      probe.store(new Response("stream", { status: 200, headers: { "content-type": "text/event-stream" } }));
      await new Promise(r => setTimeout(r, 0)); // store() resolves asynchronously
      expect(getInstalledCache()!.size).toBe(0);
    }
  });

  test("responses bypass the body cache so response ids keep continuation semantics", async () => {
    installResponseCache({ port: 10100, providers: {}, responseCache: { enabled: true, ttlMs: 10_000 } } as unknown as OcxConfig);
    const req = makeReq(
      { model: "claude-opus-4-8", input: "hi", stream: false },
      { endpoint: "responses" },
    );

    const probe = await probeResponseCache(req, baseConfig(), "responses");
    expect(probe).toBeNull();
    expect(await req.json()).toEqual({ model: "claude-opus-4-8", input: "hi", stream: false });
    expect(getInstalledCache()!.size).toBe(0);
  });
});
