import { describe, expect, test } from "bun:test";
import { handleManagementAPI } from "../src/server/management-api";
import { resolveSessionIdentity } from "../src/server/session-identity";
import { ManagementRequest } from "./helpers/management-auth";
import type { OcxConfig } from "../src/types";

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        apiKey: "test-key",
        defaultModel: "gpt-test",
      },
    },
  };
}

describe("session identity", () => {
  test("resolveSessionIdentity returns email-only none without CF Access or OIDC", async () => {
    const req = new Request("http://127.0.0.1:10100/api/whoami");
    await expect(resolveSessionIdentity(req)).resolves.toEqual({
      email: null,
      source: "none",
    });
  });

  test("GET /api/whoami is additive and never includes tokens", async () => {
    const req = new ManagementRequest("http://127.0.0.1:10100/api/whoami");
    const res = await handleManagementAPI(req, new URL(req.url), config());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res!.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["email", "source"]);
    expect(body.email).toBeNull();
    expect(body.source).toBe("none");
    expect(JSON.stringify(body)).not.toMatch(/token|secret|authorization|jwt/i);
  });
});
