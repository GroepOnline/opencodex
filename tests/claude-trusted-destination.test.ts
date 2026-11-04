import { describe, expect, test } from "bun:test";
import { buildClaudeEnv } from "../src/cli/claude";
import type { OcxConfig } from "../src/types";

const config = {
  port: 10100,
  defaultProvider: "mock",
  providers: {},
  claudeCode: { authMode: "subscription" },
  apiKeys: [{ id: "test", name: "test", key: "private-ocx-admission-key", createdAt: "2026-01-01" }],
} as OcxConfig;

describe("Claude admission credential destination", () => {
  test("does not inject the configured OCX credential into a custom endpoint", () => {
    const endpoint = "https://project-provider.invalid/v1";
    const env = buildClaudeEnv(config, 10100, { ANTHROPIC_BASE_URL: endpoint });
    expect(env.ANTHROPIC_BASE_URL).toBe(endpoint);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  test("continues injecting the configured credential for the managed loopback gateway", () => {
    const env = buildClaudeEnv(config, 10100, {});
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:10100");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("private-ocx-admission-key");
  });

  test("keeps an explicitly supplied provider credential on its custom endpoint", () => {
    const env = buildClaudeEnv(config, 10100, {
      ANTHROPIC_BASE_URL: "https://project-provider.invalid/v1",
      ANTHROPIC_AUTH_TOKEN: "provider-owned-key",
    });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("provider-owned-key");
  });
});
