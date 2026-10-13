import { describe, expect, test } from "bun:test";
import { normalizeReasoningEfforts } from "../src/server/management/reasoning-efforts";

describe("custom model reasoning ladder persistence", () => {
  test("accepts and deduplicates supported levels", () => {
    expect(normalizeReasoningEfforts(["low", "max", "low", "ultra"])).toEqual(["low", "max", "ultra"]);
  });

  test("an empty array explicitly clears the saved ladder", () => {
    expect(normalizeReasoningEfforts([])).toEqual([]);
  });

  test("filters invalid values and rejects non-arrays", () => {
    expect(normalizeReasoningEfforts(["low", "bad", 42])).toEqual(["low"]);
    expect(normalizeReasoningEfforts("high")).toBeUndefined();
  });
});
