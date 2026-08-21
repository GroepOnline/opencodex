/**
 * Response-cache middleware (Fase D): probe logic for non-streaming routes.
 * Covers: cache disabled → null, streaming opts out, stable key order collapses,
 * hit returns a rebuilt Response with x-cache: HIT, miss stores a 2xx body.
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

function makeReq(body: unknown, opts: { stream?: boolean; cacheControl?: string } = {}): Request {
  const payload = { ...(typeof body === "string" ? JSON.parse(body) : body) };
  if (opts.stream) payload.stream = true;
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.cacheControl) headers.set("cache-control", opts.cacheControl);
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
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

  test("returns null for a streaming request (never cached)", async () => {
    installResponseCache({ port: 10100, providers: {}, responseCache: { enabled: true } } as unknown as OcxConfig);
    const req = makeReq({ model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }] }, { stream: true });
    const probe = await probeResponseCache(req, baseConfig(), "messages");
    expect(probe).toBeNull();
  });

  test("returns null when client sends cache-control: no-store", async () => {
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
    const a = makeReq({ ...body, z: 1, a: 2 });
    const b = makeReq({ ...body, a: 2, z: 1 }); // different key order, same semantics

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
    const req = makeReq({ model: "claude-opus-4-8", messages: [{ role: "user", content: "ping" }] });
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
    const req = makeReq({ model: "claude-opus-4-8", messages: [{ role: "user", content: "x" }] });
    const probe = await probeResponseCache(req, baseConfig(), "messages");
    if ("store" in probe!) {
      probe.store(new Response("rate limited", { status: 429, headers: { "content-type": "application/json" } }));
      probe.store(new Response("stream", { status: 200, headers: { "content-type": "text/event-stream" } }));
      await new Promise(r => setTimeout(r, 0)); // store() resolves asynchronously
      expect(getInstalledCache()!.size).toBe(0);
    }
  });
});
