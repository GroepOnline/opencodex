import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfigCandidate } from "../src/config";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const catalogPath = join(
  repoRoot,
  "deploy/container/model-catalog.example.json",
);

describe("Azure Foundry fleet catalog", () => {
  test("example config validates and lists only the three live resources", () => {
    const raw = readFileSync(catalogPath, "utf8");
    expect(raw).not.toContain('"DeepSeek-V4-Pro"');
    expect(raw).not.toContain('"DeepSeek-V4-Pro-dz"');
    expect(raw).not.toContain('"fw-deepseek-v4-1-flash"');
    expect(raw).not.toContain('"grok-4-20-reasoning"');
    expect(raw).not.toContain('"grok-4-1-fast');
    expect(raw).not.toMatch(
      /jort-7512|amazonaws\.com|chef-platform-aws|chef-control-az-01|llama\.cpp/i,
    );
    expect(raw).not.toMatch(/\bsk-[A-Za-z0-9_-]{20,}\b/);
    const parsed = JSON.parse(raw) as {
      defaultProvider: string;
      providers: Record<
        string,
        { apiKey?: string; baseUrl: string; models: string[] }
      >;
    };
    const result = validateConfigCandidate(parsed);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.defaultProvider).toBe("azure-us");
    expect(Object.keys(result.config.providers).sort()).toEqual([
      "azure-foundry-us",
      "azure-se",
      "azure-us",
    ]);
    expect(result.config.providers["azure-us"]?.models).toEqual([
      "grok-4-6",
      "DeepSeek-V4-1-Flash",
      "fw-glm-5-3-flash",
      "fw-kimi-k3",
      "deepseek-v4-flash-0731",
      "kimi-k2-7-code",
      "fw-glm-5-3-dz",
    ]);
    expect(result.config.providers["azure-se"]?.models).toHaveLength(5);
    expect(result.config.providers["azure-foundry-us"]?.models).toEqual([
      "fw-deepseek-v4-pro",
    ]);
    expect(result.config.providers["azure-us"]?.baseUrl).toBe(
      "https://openaichef.cognitiveservices.azure.com/openai/v1",
    );
    expect(result.config.providers["azure-se"]?.baseUrl).toBe(
      "https://openaichef-se.cognitiveservices.azure.com/openai/v1",
    );
    expect(result.config.providers["azure-foundry-us"]?.baseUrl).toBe(
      "https://azure-foundry-us.cognitiveservices.azure.com/openai/v1",
    );
    for (const provider of Object.values(result.config.providers)) {
      expect(provider.apiKey).toMatch(/^\$[A-Z0-9_]+$/);
    }
  });
});
