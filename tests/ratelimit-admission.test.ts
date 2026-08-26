import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { saveConfig, validateConfigCandidate } from "../src/config";
import { startServer } from "../src/server";
import { createServerAdmissionControl } from "../src/server/rate-limit";
import { initializeManagementAuthState } from "../src/server/management-auth";
import type { WsData } from "../src/server/ws-bridge";
import type { OcxConfig, OcxRateLimitConfig } from "../src/types";

const previousHome = process.env.OPENCODEX_HOME;
const previousDataToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
const previousBindHost = process.env.OPENCODEX_BIND_HOST;
let testHome = "";

const KEY_A = "ocx_data_admitted-key-a";
const KEY_B = "ocx_data_admitted-key-b";
const KEY_C = "ocx_data_admitted-key-c";

function remoteConfig(rateLimit?: OcxRateLimitConfig): OcxConfig {
  return {
    port: 0,
    hostname: "0.0.0.0",
    defaultProvider: "test",
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        disabled: true,
        models: ["gpt-test"],
      },
    },
    apiKeys: [KEY_A, KEY_B, KEY_C].map((key, i) => ({
      id: `key-${i}`,
      name: `Admitted key ${i}`,
      key,
      createdAt: "2026-08-01T00:00:00.000Z",
    })),
    ...(rateLimit ? { rateLimit } : {}),
  };
}

function websocketHandshakeOpens(url: URL, token: string): Promise<{ opened: boolean; close: () => void }> {
  return new Promise(resolve => {
    const target = new URL("/v1/responses", url);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(target, {
      headers: { "X-OpenCodex-API-Key": token },
    } as unknown as string[]);
    let settled = false;
    const finish = (opened: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        opened,
        close: () => {
          try { socket.close(); } catch { /* already closed */ }
        },
      });
    };
    socket.addEventListener("open", () => finish(true));
    socket.addEventListener("error", () => finish(false));
    socket.addEventListener("close", () => finish(false));
    const timer = setTimeout(() => finish(false), 5_000);
  });
}

function fakeRequestServer(address: string | null): Server<WsData> {
  return {
    requestIP: () => (address ? { address, family: "IPv4", port: 4242 } : null),
  } as unknown as Server<WsData>;
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-ratelimit-admission-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.OPENCODEX_API_AUTH_TOKEN = "data-secret";
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "admin-secret";
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDataToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousDataToken;
  if (previousAdminToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdminToken;
  if (previousBindHost === undefined) delete process.env.OPENCODEX_BIND_HOST;
  else process.env.OPENCODEX_BIND_HOST = previousBindHost;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = "";
});

describe("canonical rate-limit config validation", () => {
  test("absent and disabled settings stay backward compatible", () => {
    expect(validateConfigCandidate(remoteConfig()).ok).toBe(true);
    expect(validateConfigCandidate(remoteConfig({ enabled: false })).ok).toBe(true);
    expect(validateConfigCandidate(remoteConfig({
      enabled: true,
      loopbackBypass: false,
      maxBuckets: 100,
      staleAfterMs: 60_000,
      surfaces: { "responses-http": { requestsPerMinute: 30, burst: 5 } },
      websocket: { perPrincipal: 2, global: 8 },
    })).ok).toBe(true);
  });

  test("rejects unknown surfaces, impossible bounds, and contradictory settings", () => {
    const rejects = (rateLimit: unknown, needle: string) => {
      const result = validateConfigCandidate({ ...remoteConfig(), rateLimit });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(needle);
    };
    rejects({ enabled: true, surfaces: { "not-a-surface": { requestsPerMinute: 1, burst: 1 } } }, "rateLimit");
    rejects({ enabled: true, surfaces: { images: { requestsPerMinute: 0, burst: 1 } } }, "requestsPerMinute");
    rejects({ enabled: true, surfaces: { images: { requestsPerMinute: -5, burst: 1 } } }, "requestsPerMinute");
    rejects({ enabled: true, surfaces: { images: { requestsPerMinute: 10, burst: 1.5 } } }, "burst");
    rejects({ enabled: true, maxBuckets: 0 }, "maxBuckets");
    rejects({ enabled: true, maxBuckets: 2.5 }, "maxBuckets");
    rejects({ enabled: true, staleAfterMs: 0 }, "staleAfterMs");
    rejects({ enabled: false, loopbackBypass: true }, "loopbackBypass requires enabled");
    rejects({ enabled: true, websocket: { perPrincipal: 9, global: 4 } }, "perPrincipal must not exceed");
    // Partial overrides are compared against the EFFECTIVE (default-resolved) counterpart, so a
    // global below the default perPrincipal (16) or a perPrincipal above the default global (128)
    // cannot slip past validation and contradict the runtime defaults.
    rejects({ enabled: true, websocket: { global: 1 } }, "perPrincipal must not exceed");
    rejects({ enabled: true, websocket: { perPrincipal: 200 } }, "perPrincipal must not exceed");
    expect(validateConfigCandidate({ ...remoteConfig(), rateLimit: { enabled: true, websocket: { global: 16 } } }).ok).toBe(true);
    expect(validateConfigCandidate({ ...remoteConfig(), rateLimit: { enabled: true, websocket: { perPrincipal: 128 } } }).ok).toBe(true);
    rejects({ enabled: true, unknownField: true }, "rateLimit");
    // The HMAC secret is process-local and must never be configurable or persisted.
    rejects({ enabled: true, secret: "attacker-chosen" }, "rateLimit");
  });
});

describe("admission rate limiting end to end", () => {
  test("feature off: no limiting, no RateLimit headers, behavior unchanged", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      for (let i = 0; i < 5; i++) {
        const response = await fetch(new URL("/v1/models", server.url), {
          headers: { "x-opencodex-api-key": KEY_A },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("RateLimit-Limit")).toBeNull();
        expect(response.headers.get("Retry-After")).toBeNull();
      }
    } finally {
      await server.stop(true);
    }
  });

  test("distinct admitted keys isolate buckets; OpenAI envelope carries integer headers", async () => {
    saveConfig(remoteConfig({
      enabled: true,
      surfaces: { "model-discovery": { requestsPerMinute: 1, burst: 1 } },
    }));
    const server = startServer(0);
    try {
      const first = await fetch(new URL("/v1/models", server.url), {
        headers: { "x-opencodex-api-key": KEY_A },
      });
      expect(first.status).toBe(200);

      const denied = await fetch(new URL("/v1/models", server.url), {
        headers: { "x-opencodex-api-key": KEY_A },
      });
      expect(denied.status).toBe(429);
      const body = await denied.json() as { error: { type: string; code: string; message: string } };
      expect(body.error.type).toBe("rate_limit_error");
      expect(body.error.code).toBe("rate_limit_exceeded");
      expect(body.error.message).not.toContain(KEY_A);
      for (const header of ["Retry-After", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"]) {
        const value = denied.headers.get(header);
        expect(value).not.toBeNull();
        expect(Number.isInteger(Number(value))).toBe(true);
      }
      expect(Number(denied.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);

      // A different validated key keeps its own untouched bucket.
      const other = await fetch(new URL("/v1/models", server.url), {
        headers: { "x-opencodex-api-key": KEY_B },
      });
      expect(other.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("spoofed loopback Origin cannot bypass an exhausted bucket", async () => {
    saveConfig(remoteConfig({
      enabled: true,
      surfaces: { "model-discovery": { requestsPerMinute: 1, burst: 1 } },
    }));
    const server = startServer(0);
    try {
      expect((await fetch(new URL("/v1/models", server.url), {
        headers: { "x-opencodex-api-key": KEY_A },
      })).status).toBe(200);
      const spoofed = await fetch(new URL("/v1/models", server.url), {
        headers: {
          "x-opencodex-api-key": KEY_A,
          Origin: "http://localhost:10100",
        },
      });
      expect(spoofed.status).toBe(429);
    } finally {
      await server.stop(true);
    }
  });

  test("invalid keys always receive 401 and never mint or consume limiter buckets", async () => {
    saveConfig(remoteConfig({
      enabled: true,
      surfaces: { "model-discovery": { requestsPerMinute: 1, burst: 2 } },
    }));
    const server = startServer(0);
    try {
      // Auth-first admission (documented by tests/ratelimit-auth-precedence.test.ts): invalid
      // credentials are rejected by the existing auth layer before any limiter state is touched,
      // so rotated fake keys keep getting 401 well past the surface burst and carry no
      // rate-limit headers.
      for (const invalid of ["invalid-key-1", "invalid-key-2", "invalid-key-3", "invalid-key-4"]) {
        const response = await fetch(new URL("/v1/models", server.url), {
          headers: { "x-opencodex-api-key": invalid },
        });
        expect(response.status).toBe(401);
        expect(response.headers.get("RateLimit-Limit")).toBeNull();
      }
      // The invalid-key flood consumed no budget: a validated key still has its full burst.
      expect((await fetch(new URL("/v1/models", server.url), {
        headers: { "x-opencodex-api-key": KEY_A },
      })).status).toBe(200);
      expect((await fetch(new URL("/v1/models", server.url), {
        headers: { "x-opencodex-api-key": KEY_A },
      })).status).toBe(200);
      expect((await fetch(new URL("/v1/models", server.url), {
        headers: { "x-opencodex-api-key": KEY_A },
      })).status).toBe(429);
    } finally {
      await server.stop(true);
    }
  });

  test("validated principals keep 403 origin precedence over post-auth rate limiting", async () => {
    saveConfig(remoteConfig({
      enabled: true,
      surfaces: { "model-discovery": { requestsPerMinute: 1, burst: 1 } },
    }));
    const server = startServer(0);
    try {
      expect((await fetch(new URL("/v1/models", server.url), {
        headers: { "x-opencodex-api-key": KEY_A },
      })).status).toBe(200);
      // Over limit AND cross-origin: the origin rejection wins for validated principals.
      const crossOrigin = await fetch(new URL("/v1/models", server.url), {
        headers: {
          "x-opencodex-api-key": KEY_A,
          Origin: "http://evil.example",
        },
      });
      expect(crossOrigin.status).toBe(403);
    } finally {
      await server.stop(true);
    }
  });

  test("loopback bypass is explicit: default off limits loopback callers, opting in exempts them", async () => {
    saveConfig(remoteConfig({
      enabled: true,
      surfaces: { "model-discovery": { requestsPerMinute: 1, burst: 1 } },
    }));
    const limited = startServer(0);
    try {
      expect((await fetch(new URL("/v1/models", limited.url), {
        headers: { "x-opencodex-api-key": KEY_A },
      })).status).toBe(200);
      expect((await fetch(new URL("/v1/models", limited.url), {
        headers: { "x-opencodex-api-key": KEY_A },
      })).status).toBe(429);
    } finally {
      await limited.stop(true);
    }

    // Fresh config home: rewriting config.json under the same home would collide with the
    // OpenAI-tier migration backup taken by the first start.
    const bypassHome = mkdtempSync(join(tmpdir(), "ocx-ratelimit-bypass-"));
    process.env.OPENCODEX_HOME = bypassHome;
    try {
      saveConfig(remoteConfig({
        enabled: true,
        loopbackBypass: true,
        surfaces: { "model-discovery": { requestsPerMinute: 1, burst: 1 } },
      }));
      const bypassed = startServer(0);
      try {
        for (let i = 0; i < 3; i++) {
          expect((await fetch(new URL("/v1/models", bypassed.url), {
            headers: { "x-opencodex-api-key": KEY_A },
          })).status).toBe(200);
        }
      } finally {
        await bypassed.stop(true);
      }
    } finally {
      rmSync(bypassHome, { recursive: true, force: true });
    }
  });

  test("Claude routes return the Anthropic 429 envelope", async () => {
    saveConfig(remoteConfig({
      enabled: true,
      surfaces: { "claude-messages": { requestsPerMinute: 1, burst: 1 } },
    }));
    const server = startServer(0);
    try {
      const request = () => fetch(new URL("/v1/messages/count_tokens", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": KEY_A,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] }),
      });
      const first = await request();
      expect(first.status).not.toBe(429);
      const denied = await request();
      expect(denied.status).toBe(429);
      const body = await denied.json() as { type: string; error: { type: string; message: string } };
      expect(body.type).toBe("error");
      expect(body.error.type).toBe("rate_limit_error");
      expect(body.error.message).not.toContain(KEY_A);
      expect(Number.isInteger(Number(denied.headers.get("Retry-After")))).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("management requests use the management JSON envelope", async () => {
    saveConfig(remoteConfig({
      enabled: true,
      surfaces: { management: { requestsPerMinute: 1, burst: 1 } },
    }));
    const server = startServer(0);
    try {
      const first = await fetch(new URL("/api/config", server.url), {
        headers: { "x-opencodex-api-key": "admin-secret" },
      });
      expect(first.status).toBe(200);
      const denied = await fetch(new URL("/api/config", server.url), {
        headers: { "x-opencodex-api-key": "admin-secret" },
      });
      expect(denied.status).toBe(429);
      expect(await denied.json()).toEqual({ error: "rate limit exceeded; retry later" });
      expect(Number.isInteger(Number(denied.headers.get("Retry-After")))).toBe(true);
      expect(Number.isInteger(Number(denied.headers.get("RateLimit-Reset")))).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("/metrics shares the management admission bucket with /api/*", async () => {
    saveConfig(remoteConfig({
      enabled: true,
      surfaces: { management: { requestsPerMinute: 1, burst: 2 } },
    }));
    const server = startServer(0);
    try {
      // First scrape and first /api call drain the shared burst-2 management bucket...
      const scrape = await fetch(new URL("/metrics", server.url), {
        headers: { "x-opencodex-api-key": "admin-secret" },
      });
      expect(scrape.status).toBe(200);
      expect((await fetch(new URL("/api/config", server.url), {
        headers: { "x-opencodex-api-key": "admin-secret" },
      })).status).toBe(200);
      // ...so the next scrape is denied with the management JSON envelope and integer headers.
      const denied = await fetch(new URL("/metrics", server.url), {
        headers: { "x-opencodex-api-key": "admin-secret" },
      });
      expect(denied.status).toBe(429);
      expect(await denied.json()).toEqual({ error: "rate limit exceeded; retry later" });
      expect(Number.isInteger(Number(denied.headers.get("Retry-After")))).toBe(true);

      // Auth-first admission: unauthenticated probes against /metrics are rejected by the
      // management auth layer before any limiter state is touched, so rotated wrong tokens
      // keep getting 401 even while the validated admin bucket above is exhausted.
      for (const wrongToken of ["wrong-token-1", "wrong-token-2", "wrong-token-3"]) {
        const probe = await fetch(new URL("/metrics", server.url), {
          headers: { "x-opencodex-api-key": wrongToken },
        });
        expect(probe.status).toBe(401);
        expect(probe.headers.get("RateLimit-Limit")).toBeNull();
      }
    } finally {
      await server.stop(true);
    }
  });

  test("bucket hard cap charges new principals to the shared overflow bucket", async () => {
    saveConfig(remoteConfig({
      enabled: true,
      maxBuckets: 1,
      staleAfterMs: 600_000,
      surfaces: { "model-discovery": { requestsPerMinute: 1, burst: 1 } },
    }));
    const server = startServer(0);
    try {
      // KEY_A claims the single principal bucket.
      expect((await fetch(new URL("/v1/models", server.url), {
        headers: { "x-opencodex-api-key": KEY_A },
      })).status).toBe(200);
      // KEY_B lands in the shared per-surface overflow bucket (fail-closed, never waved through).
      expect((await fetch(new URL("/v1/models", server.url), {
        headers: { "x-opencodex-api-key": KEY_B },
      })).status).toBe(200);
      // KEY_C shares that exhausted overflow bucket instead of allocating a third bucket.
      expect((await fetch(new URL("/v1/models", server.url), {
        headers: { "x-opencodex-api-key": KEY_C },
      })).status).toBe(429);
    } finally {
      await server.stop(true);
    }
  });

  test("WebSocket concurrency: request-rate charge, reservation caps, and release on close", async () => {
    const config = remoteConfig({
      enabled: true,
      websocket: { perPrincipal: 1, global: 1 },
    });
    config.websockets = true;
    saveConfig(config);
    const server = startServer(0);
    try {
      const first = await websocketHandshakeOpens(server.url, KEY_A);
      expect(first.opened).toBe(true);

      // Per-principal and global caps are enforced before the handshake completes.
      const overCap = await websocketHandshakeOpens(server.url, KEY_A);
      expect(overCap.opened).toBe(false);
      const otherPrincipal = await websocketHandshakeOpens(server.url, KEY_B);
      expect(otherPrincipal.opened).toBe(false);

      // Closing the socket releases the reservation for the next handshake.
      first.close();
      let reopened = false;
      for (let attempt = 0; attempt < 20 && !reopened; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        const retry = await websocketHandshakeOpens(server.url, KEY_B);
        reopened = retry.opened;
        if (retry.opened) retry.close();
      }
      expect(reopened).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("WebSocket handshakes are charged against the responses-websocket request rate", async () => {
    const config = remoteConfig({
      enabled: true,
      surfaces: { "responses-websocket": { requestsPerMinute: 1, burst: 1 } },
    });
    config.websockets = true;
    saveConfig(config);
    const server = startServer(0);
    try {
      const first = await websocketHandshakeOpens(server.url, KEY_A);
      expect(first.opened).toBe(true);
      first.close();
      const denied = await websocketHandshakeOpens(server.url, KEY_A);
      expect(denied.opened).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test("repeated server starts never leak limiter state across instances", async () => {
    saveConfig(remoteConfig({
      enabled: true,
      surfaces: { "model-discovery": { requestsPerMinute: 1, burst: 1 } },
    }));
    const first = startServer(0);
    try {
      expect((await fetch(new URL("/v1/models", first.url), {
        headers: { "x-opencodex-api-key": KEY_A },
      })).status).toBe(200);
      expect((await fetch(new URL("/v1/models", first.url), {
        headers: { "x-opencodex-api-key": KEY_A },
      })).status).toBe(429);
    } finally {
      await first.stop(true);
    }

    const second = startServer(0);
    try {
      expect((await fetch(new URL("/v1/models", second.url), {
        headers: { "x-opencodex-api-key": KEY_A },
      })).status).toBe(200);
    } finally {
      await second.stop(true);
    }
  });
});

describe("admission control unit boundaries", () => {
  test("a failed upgrade rollback releases the reservation for the next handshake", () => {
    const config = remoteConfig({ enabled: true, websocket: { perPrincipal: 1, global: 1 } });
    const managementAuth = initializeManagementAuthState(config);
    const admission = createServerAdmissionControl(config, managementAuth);
    const requestServer = fakeRequestServer("203.0.113.7");
    const req = new Request("http://example.test/v1/responses", {
      headers: { "x-opencodex-api-key": KEY_A },
    });

    const gate = admission.gate("responses-websocket", req, requestServer);
    const reservation = gate.reserveConcurrency();
    expect(reservation instanceof Response).toBe(false);
    if (reservation instanceof Response) throw new Error("expected accepted reservation");

    // Cap reached while the reservation is held.
    const denied = admission.gate("responses-websocket", req, requestServer).reserveConcurrency();
    expect(denied instanceof Response).toBe(true);
    if (denied instanceof Response) expect(denied.status).toBe(429);

    // The upgrade-failure rollback path: release, then the next handshake is admitted again.
    reservation.release();
    reservation.release(); // idempotent
    const retried = admission.gate("responses-websocket", req, requestServer).reserveConcurrency();
    expect(retried instanceof Response).toBe(false);
  });

  test("live sideband reservations enforce per-principal and global caps with rollback", () => {
    const config = remoteConfig({ enabled: true, websocket: { perPrincipal: 1, global: 2 } });
    const managementAuth = initializeManagementAuthState(config);
    const admission = createServerAdmissionControl(config, managementAuth);
    const requestServer = fakeRequestServer("203.0.113.7");
    const reqFor = (key: string) => new Request("http://example.test/v1/live/rtc_1", {
      headers: { "x-opencodex-api-key": key },
    });

    // Accepted reservation for the first sideband join of a principal.
    const first = admission.gate("live", reqFor(KEY_A), requestServer).reserveConcurrency();
    expect(first instanceof Response).toBe(false);
    if (first instanceof Response) throw new Error("expected accepted reservation");

    // Per-principal cap: a second join by the same principal is denied 429.
    const perPrincipalDenied = admission.gate("live", reqFor(KEY_A), requestServer).reserveConcurrency();
    expect(perPrincipalDenied instanceof Response).toBe(true);
    if (perPrincipalDenied instanceof Response) expect(perPrincipalDenied.status).toBe(429);

    // Global cap: a second principal takes the last global slot, a third is denied.
    const second = admission.gate("live", reqFor(KEY_B), requestServer).reserveConcurrency();
    expect(second instanceof Response).toBe(false);
    if (second instanceof Response) throw new Error("expected accepted reservation");
    const globalDenied = admission.gate("live", reqFor(KEY_C), requestServer).reserveConcurrency();
    expect(globalDenied instanceof Response).toBe(true);
    if (globalDenied instanceof Response) expect(globalDenied.status).toBe(429);

    // Failed-upgrade rollback: releasing (idempotently) readmits the same principal.
    first.release();
    first.release(); // idempotent, mirrors close() firing after an explicit rollback
    const retried = admission.gate("live", reqFor(KEY_A), requestServer).reserveConcurrency();
    expect(retried instanceof Response).toBe(false);
    if (!(retried instanceof Response)) retried.release();
    second.release();
  });

  test("aggregate snapshot exposes counts only, never principals or fingerprints", () => {
    const config = remoteConfig({
      enabled: true,
      surfaces: { "responses-http": { requestsPerMinute: 1, burst: 1 } },
    });
    const managementAuth = initializeManagementAuthState(config);
    const admission = createServerAdmissionControl(config, managementAuth);
    const requestServer = fakeRequestServer("203.0.113.7");
    const req = new Request("http://example.test/v1/responses", {
      headers: { "x-opencodex-api-key": KEY_A },
    });

    const first = admission.gate("responses-http", req, requestServer);
    expect(first.preAuthDeny).toBeNull();
    expect(first.commit()).toBeNull();
    const second = admission.gate("responses-http", req, requestServer);
    expect(second.commit()).not.toBeNull();

    const snapshot = admission.snapshot();
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.requests).toEqual([
      { surface: "responses-http", source: "principal", result: "allowed", count: 1 },
      { surface: "responses-http", source: "principal", result: "denied", count: 1 },
    ]);
    expect(snapshot.buckets.principals).toBe(1);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(KEY_A);
    expect(serialized).not.toContain("admission-key:");
    expect(serialized).not.toContain("203.0.113.7");

    // Explicit reset boundary for tests and shutdown.
    admission.reset();
    expect(admission.snapshot().requests).toEqual([]);
    expect(admission.gate("responses-http", req, requestServer).commit()).toBeNull();
  });

  test("OPENCODEX_BIND_HOST=0.0.0.0 is not loopback-bound when config hostname is loopback", () => {
    process.env.OPENCODEX_BIND_HOST = "0.0.0.0";
    const config = {
      ...remoteConfig({
        enabled: true,
        loopbackBypass: true,
        surfaces: { "responses-http": { requestsPerMinute: 1, burst: 1 } },
      }),
      hostname: "127.0.0.1",
    };
    const admission = createServerAdmissionControl(config, initializeManagementAuthState(config));
    const req = new Request("http://example.test/v1/responses", {
      headers: { "x-opencodex-api-key": KEY_A },
    });
    const unknownAddress = fakeRequestServer(null);
    expect(admission.gate("responses-http", req, unknownAddress).commit()).toBeNull();
    expect(admission.gate("responses-http", req, unknownAddress).commit()).not.toBeNull();
  });

  test("loopback OPENCODEX_BIND_HOST stays loopback-bound when requestIP is unavailable", () => {
    process.env.OPENCODEX_BIND_HOST = "127.0.0.1";
    const config = remoteConfig({
      enabled: true,
      loopbackBypass: true,
      surfaces: { "responses-http": { requestsPerMinute: 1, burst: 1 } },
    });
    const admission = createServerAdmissionControl(config, initializeManagementAuthState(config));
    const req = new Request("http://example.test/v1/responses", {
      headers: { "x-opencodex-api-key": KEY_A },
    });
    const unknownAddress = fakeRequestServer(null);
    for (let i = 0; i < 3; i++) {
      expect(admission.gate("responses-http", req, unknownAddress).commit()).toBeNull();
    }
  });

  test("loopback bypass keys on the trusted socket address, never on Origin", () => {
    const config = remoteConfig({
      enabled: true,
      loopbackBypass: true,
      surfaces: { "responses-http": { requestsPerMinute: 1, burst: 1 } },
    });
    const managementAuth = initializeManagementAuthState(config);
    const admission = createServerAdmissionControl(config, managementAuth);

    // Remote socket with a spoofed loopback Origin stays limited.
    const remoteReq = new Request("http://example.test/v1/responses", {
      headers: { "x-opencodex-api-key": KEY_A, Origin: "http://localhost:10100" },
    });
    const remote = fakeRequestServer("203.0.113.7");
    expect(admission.gate("responses-http", remoteReq, remote).commit()).toBeNull();
    expect(admission.gate("responses-http", remoteReq, remote).commit()).not.toBeNull();

    // A genuine loopback socket is exempt.
    const loopback = fakeRequestServer("127.0.0.1");
    for (let i = 0; i < 3; i++) {
      expect(admission.gate("responses-http", remoteReq, loopback).commit()).toBeNull();
    }
  });
});
