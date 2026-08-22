import { describe, expect, test } from "bun:test";
import { providerAvailabilityLine, type WorkspaceItem } from "../src/provider-workspace/catalog";

describe("providerAvailabilityLine", () => {
  test("counts a key pool and the first hop target", () => {
    const item: WorkspaceItem = {
      name: "meta-ai",
      adapter: "openai-chat",
      baseUrl: "https://api.meta.ai/v1",
      hasApiKey: true,
      keyPoolCount: 3,
      fallback: [{ provider: "opencode-zen", model: "zen" }],
    };
    expect(providerAvailabilityLine(item)).toEqual({
      poolCount: 3,
      hopProvider: "opencode-zen",
    });
  });

  test("is a single key with no hop when the pool is not configured", () => {
    const item: WorkspaceItem = {
      name: "deepseek",
      adapter: "openai-chat",
      baseUrl: "https://api.deepseek.com",
      hasApiKey: true,
    };
    expect(providerAvailabilityLine(item)).toEqual({ poolCount: 1 });
  });
});
