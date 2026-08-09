import { describe, expect, it } from "bun:test";
import { lookupPricing, estimateCostEur } from "../src/usage/pricing";

describe("lookupPricing", () => {
  it("returns free for unknown provider", () => {
    expect(lookupPricing("unknown-provider", "some-model")).toEqual({ inputPer1k: 0, outputPer1k: 0 });
  });

  it("returns model-specific pricing when available", () => {
    const p = lookupPricing("openai", "gpt-4o");
    expect(p.inputPer1k).toBeGreaterThan(0);
    expect(p.outputPer1k).toBeGreaterThan(0);
  });

  it("falls back to provider-level pricing for unknown model", () => {
    const p = lookupPricing("openai", "gpt-99-future");
    expect(p.inputPer1k).toBeGreaterThan(0); // falls back to openai default
  });

  it("prefix-matches model families (e.g. claude-sonnet-4-5-20250929)", () => {
    const p = lookupPricing("anthropic", "claude-sonnet-4-5-20250929");
    expect(p.inputPer1k).toBeGreaterThan(0);
  });

  it("returns free for self-hosted providers (ollama, litellm)", () => {
    expect(lookupPricing("ollama-cloud", "llama3")).toEqual({ inputPer1k: 0, outputPer1k: 0 });
    expect(lookupPricing("litellm", "my-model")).toEqual({ inputPer1k: 0, outputPer1k: 0 });
  });
});

describe("estimateCostEur", () => {
  it("estimates cost for a known provider/model", () => {
    // openai:gpt-4o = 0.0023 in / 0.0092 out per 1k
    // 1000 in + 500 out = 0.0023 + 0.0046 = 0.0069
    const cost = estimateCostEur("openai", "gpt-4o", 1000, 500);
    expect(cost).toBeCloseTo(0.0069, 4);
  });

  it("returns 0 for free providers", () => {
    expect(estimateCostEur("omniroute", "any-model", 1_000_000, 1_000_000)).toBe(0);
    expect(estimateCostEur("ollama-cloud", "llama3", 1_000_000, 1_000_000)).toBe(0);
  });

  it("returns 0 for unknown providers", () => {
    expect(estimateCostEur("unknown", "model", 1000, 1000)).toBe(0);
  });
});
