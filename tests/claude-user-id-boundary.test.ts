import { describe, expect, test } from "bun:test";
import { anthropicToResponsesTranslation } from "../src/claude/inbound";

describe("Claude Responses user identifier boundary", () => {
  test("bounds long metadata.user_id and reuses the cache-affinity key", () => {
    const userId = `claude-session-${"x".repeat(140)}`;
    const { body, cacheKeySource } = anthropicToResponsesTranslation({
      model: "mock/test-model",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
      metadata: { user_id: userId },
    });

    expect(cacheKeySource).toBe("metadata");
    expect(body.user).toMatch(/^[0-9a-f]{32}$/);
    expect((body.user as string).length).toBeLessThanOrEqual(64);
    expect(body.user).toBe(body.prompt_cache_key);
  });

  test("keeps the derived identifier stable per Claude session", () => {
    const translate = (user_id: string) => anthropicToResponsesTranslation({
      model: "mock/test-model",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
      metadata: { user_id },
    }).body.user;

    expect(translate("session-a")).toBe(translate("session-a"));
    expect(translate("session-a")).not.toBe(translate("session-b"));
  });
});
