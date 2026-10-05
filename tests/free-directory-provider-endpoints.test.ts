import { describe, expect, test } from "bun:test";
import { FREE_PROVIDER_DIRECTORY } from "../src/providers/free-directory";

function provider(id: string) {
  const entry = FREE_PROVIDER_DIRECTORY.find((candidate) => candidate.id === id);
  expect(entry).toBeDefined();
  return entry!;
}

describe("free-directory provider endpoint contracts", () => {
  test("pins the verified Cohere OpenAI-compatibility endpoints", () => {
    expect(provider("cohere")).toMatchObject({
      baseUrl: "https://api.cohere.ai/compatibility/v1",
      modelsUrl: "https://api.cohere.ai/compatibility/v1/models",
      verification: "official",
    });
  });

  test("pins the verified Nebius OpenAI-compatible base URL", () => {
    expect(provider("nebius")).toMatchObject({
      baseUrl: "https://api.studio.nebius.com/v1",
      verification: "official",
    });
  });
});
