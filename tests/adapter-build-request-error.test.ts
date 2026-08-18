import { describe, expect, test } from "bun:test";
import { handleResponses } from "../src/server/responses";
import { adapterBuildRequestError } from "../src/server/responses/core";
import type { OcxConfig } from "../src/types";

describe("adapterBuildRequestError", () => {
  test.each([
    ["openai-chat requires a non-empty credential (authMode: key)"],
    ["anthropic provider requires a non-empty apiKey (authMode: key)"],
    ["azure-openai requires a non-empty apiKey"],
    ["google (AI Studio) requires a non-empty API key"],
    ["google-antigravity oauth token missing — run ocx login google-antigravity"],
    ["anthropic oauth token missing — run ocx login anthropic"],
    ["kiro token missing — run ocx login kiro"],
    ["Cursor live transport requires a Cursor access token in provider.apiKey, Authorization, or OPENCODEX_CURSOR_TEST_TOKEN."],
    ["Codex pool account auth is required but unavailable"],
  ])("returns JSON 401 for missing credential message: %s", async (rawMessage) => {
    const response = adapterBuildRequestError(new Error(rawMessage));
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    const body = await response.json() as { error?: { type?: string } };
    expect(body.error?.type).toBe("authentication_error");
  });

  test("returns JSON 500 for non-credential adapter config failures", async () => {
    const response = adapterBuildRequestError(new Error("google-antigravity requires a non-empty baseUrl"));
    expect(response.status).toBe(500);
    const body = await response.json() as { error?: { type?: string } };
    expect(body.error?.type).toBe("server_error");
  });

  test("classifies cursor_missing_credential code as 401", async () => {
    const err = new Error("ignored message");
    Object.assign(err, { code: "cursor_missing_credential" });
    const response = adapterBuildRequestError(err);
    expect(response.status).toBe(401);
  });
});

describe("adapter buildRequest failures", () => {
  test("empty openai-chat credential returns JSON 401 instead of throwing", async () => {
    const config = {
      port: 0,
      defaultProvider: "deepseek",
      providers: {
        deepseek: {
          adapter: "openai-chat",
          baseUrl: "https://api.deepseek.com",
          authMode: "key",
        },
      },
    } as unknown as OcxConfig;

    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "deepseek/deepseek-v4-flash",
          input: "hi",
          stream: false,
        }),
      }),
      config,
      { model: "", provider: "" },
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    const body = await response.json() as { error?: { message?: string; type?: string } };
    expect(body.error?.type).toBe("authentication_error");
    expect(body.error?.message ?? "").toMatch(/non-empty credential/i);
  });
});
