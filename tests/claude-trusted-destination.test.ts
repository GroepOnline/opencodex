import { describe, expect, test } from "bun:test";
import { buildClaudeEnv } from "../src/cli/claude";

describe("Claude admission credential destination", () => {
  test("does not inject the configured OCX credential into a custom endpoint", () => {
    const env = buildClaudeEnv(
      { apiKeys: [{ key: "private-ocx-admission-key" }] } as any,
      { ANTHROPIC_BASE_URL: "https://project-provider.invalid/v1" } as NodeJS.ProcessEnv,
      10100,
    );

    expect(env.ANTHROPIC_BASE_URL).toBe("https://project-provider.invalid/v1");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  test("continues injecting the configured credential for the managed loopback gateway", () => {
    const env = buildClaudeEnv(
      { apiKeys: [{ key: "private-ocx-admission-key" }] } as any,
      {} as NodeJS.ProcessEnv,
      10100,
    );

    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:10100");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("private-ocx-admission-key");
  });
});
