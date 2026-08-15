import { describe, expect, test } from "bun:test";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig } from "../src/types";

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
