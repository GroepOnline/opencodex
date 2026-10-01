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

describe("generic model catalog example", () => {
  test("validates without ChefGroep production inventory", () => {
    const raw = readFileSync(catalogPath, "utf8");

    expect(raw).toContain("example-openai");
    expect(raw).toContain("https://api.example.com/v1");
    expect(raw).toContain("$EXAMPLE_OPENAI_API_KEY");

    for (const forbidden of [
      "amazonaws.com",
      "/home/",
      "tailscale",
      "private deployment",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
    expect(raw).not.toMatch(/\bsk-[A-Za-z0-9_-]{20,}\b/);

    const parsed = JSON.parse(raw);
    const result = validateConfigCandidate(parsed);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.config.defaultProvider).toBe("example-openai");
    expect(Object.keys(result.config.providers)).toEqual(["example-openai"]);
    expect(result.config.providers["example-openai"]?.models).toEqual([
      "example-chat",
    ]);
    expect(result.config.providers["example-openai"]?.apiKey).toBe(
      "$EXAMPLE_OPENAI_API_KEY",
    );
  });
});
