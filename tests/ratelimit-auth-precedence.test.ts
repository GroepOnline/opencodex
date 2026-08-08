import { describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { initializeManagementAuthState } from "../src/server/management-auth";
import { createServerAdmissionControl } from "../src/server/rate-limit";
import type { WsData } from "../src/server/ws-bridge";
import type { OcxConfig } from "../src/types";

const VALID_KEY = "ocx_data_auth-first-valid";

function config(): OcxConfig {
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
    apiKeys: [{
      id: "valid",
      name: "Valid",
      key: VALID_KEY,
      createdAt: "2026-08-02T00:00:00.000Z",
    }],
    rateLimit: {
      enabled: true,
      surfaces: {
        "model-discovery": { requestsPerMinute: 1, burst: 1 },
      },
    },
  };
}

function fakeServer(address = "203.0.113.7"): Server<WsData> {
  return {
    requestIP: () => ({ address, family: "IPv4", port: 4242 }),
  } as unknown as Server<WsData>;
}

function request(key: string): Request {
  return new Request("http://example.test/v1/models", {
    headers: { "x-opencodex-api-key": key },
  });
}

describe("auth-first rate-limit precedence", () => {
  test("uncommitted invalid credentials allocate and consume no limiter state", () => {
    const cfg = config();
    const admission = createServerAdmissionControl(cfg, initializeManagementAuthState(cfg));
    const server = fakeServer();

    for (const invalid of ["invalid-one", "invalid-two", "invalid-three"]) {
      const gate = admission.gate("model-discovery", request(invalid), server);
      expect(gate.preAuthDeny).toBeNull();
      // Existing auth returns 401 before commit() is called.
    }

    expect(admission.snapshot()).toEqual({
      enabled: true,
      requests: [],
      buckets: { principals: 0, overflowSurfaces: 0 },
      websocket: {
        globalCount: 0,
        trackedPrincipals: 0,
        stats: {
          accepted: 0,
          deniedGlobal: 0,
          deniedPrincipal: 0,
          deniedPrincipalCapacity: 0,
        },
      },
    });
  });

  test("a validated credential is charged only at commit and remains isolated", async () => {
    const cfg = config();
    const admission = createServerAdmissionControl(cfg, initializeManagementAuthState(cfg));
    const server = fakeServer();

    const first = admission.gate("model-discovery", request(VALID_KEY), server);
    expect(first.preAuthDeny).toBeNull();
    expect(admission.snapshot().buckets.principals).toBe(0);
    expect(first.commit()).toBeNull();
    expect(admission.snapshot().buckets.principals).toBe(1);

    // Commit is idempotent for the same request gate.
    expect(first.commit()).toBeNull();
    expect(admission.snapshot().requests).toEqual([
      { surface: "model-discovery", source: "principal", result: "allowed", count: 1 },
    ]);

    const second = admission.gate("model-discovery", request(VALID_KEY), server);
    const denied = second.commit();
    expect(denied).toBeInstanceOf(Response);
    expect(denied?.status).toBe(429);
    expect(await denied?.json()).toEqual({
      error: {
        message: expect.stringContaining("Rate limit exceeded"),
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      },
    });
    expect(admission.snapshot().requests).toEqual([
      { surface: "model-discovery", source: "principal", result: "allowed", count: 1 },
      { surface: "model-discovery", source: "principal", result: "denied", count: 1 },
    ]);
  });
});
