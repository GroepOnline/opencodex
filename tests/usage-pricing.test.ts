import { describe, expect, it } from "bun:test";
import { estimateCostEur, lookupPricing } from "../src/usage/pricing";

describe("lookupPricing", () => {
  it("prefers an exact model key over the provider default", () => {
    expect(lookupPricing("openai", "gpt-4o-mini")).toEqual(lookupPricing("openai", "GPT-4O-MINI"));
    expect(lookupPricing("openai", "gpt-4o-mini").inputPer1k)
      .toBeLessThan(lookupPricing("openai").inputPer1k);
  });

  it("picks the longest matching model prefix", () => {
    // "openai:gpt-4o" is declared first, so a first-match lookup would price the
    // dated mini snapshot at the flagship rate.
    expect(lookupPricing("openai", "gpt-4o-mini-2024-07-18"))
      .toEqual(lookupPricing("openai", "gpt-4o-mini"));
    expect(lookupPricing("anthropic", "claude-sonnet-4-5-20250929"))
      .toEqual(lookupPricing("anthropic", "claude-sonnet-4-5"));
  });

  it("falls back to the provider entry, then to free", () => {
    expect(lookupPricing("openai", "some-unlisted-model")).toEqual(lookupPricing("openai"));
    expect(lookupPricing("not-a-provider")).toEqual({ inputPer1k: 0, outputPer1k: 0 });
  });
});

describe("estimateCostEur", () => {
  it("scales cost per 1k tokens", () => {
    const p = lookupPricing("openai", "gpt-4o");
    expect(estimateCostEur("openai", "gpt-4o", 1000, 2000))
      .toBeCloseTo(p.inputPer1k + 2 * p.outputPer1k, 10);
  });

  it("ignores malformed token counts instead of returning a negative or NaN cost", () => {
    expect(estimateCostEur("openai", "gpt-4o", -100, 200))
      .toBe(estimateCostEur("openai", "gpt-4o", 0, 200));
    expect(estimateCostEur("openai", "gpt-4o", Number.NaN, Number.POSITIVE_INFINITY)).toBe(0);
    expect(estimateCostEur("openai", "gpt-4o", -100, -200)).toBe(0);
  });
});
