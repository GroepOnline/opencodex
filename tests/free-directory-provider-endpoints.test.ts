import { describe, expect, test } from "bun:test";
import { FREE_PROVIDER_DIRECTORY } from "../src/providers/free-directory";

function provider(id: string) {
  const entry = FREE_PROVIDER_DIRECTORY.find(
    (candidate) => candidate.id === id,
  );
  expect(entry).toBeDefined();
  return entry!;
}

describe("free-directory provider endpoint contracts", () => {
  test("pins the verified NEAR AI Cloud endpoints", () => {
    expect(provider("nearai")).toMatchObject({
      baseUrl: "https://cloud-api.near.ai/v1",
      modelsUrl: "https://cloud-api.near.ai/v1/models",
      verification: "official",
    });
  });

  test("pins the verified UnoRouter endpoints", () => {
    expect(provider("unorouter")).toMatchObject({
      baseUrl: "https://api.unorouter.com/v1",
      modelsUrl: "https://api.unorouter.com/v1/models",
      verification: "primary",
    });
  });

  test("pins the verified ChatAnywhere endpoints", () => {
    expect(provider("chatanywhere")).toMatchObject({
      baseUrl: "https://api.chatanywhere.tech/v1",
      modelsUrl: "https://api.chatanywhere.tech/v1/models",
      verification: "official",
    });
  });

  test("pins the keyless UncloseAI hermes endpoint", () => {
    expect(provider("uncloseai")).toMatchObject({
      baseUrl: "https://hermes.ai.unturf.com/v1",
      modelsUrl: "https://hermes.ai.unturf.com/v1/models",
      verification: "official",
      keyOptional: true,
    });
  });

  test("pins the keyless LLM7 endpoint", () => {
    expect(provider("llm7")).toMatchObject({
      baseUrl: "https://api.llm7.io/v1",
      modelsUrl: "https://api.llm7.io/v1/models",
      verification: "primary",
      keyOptional: true,
    });
  });

  test("pins the keyless NavyAI endpoint", () => {
    expect(provider("navy")).toMatchObject({
      baseUrl: "https://api.navy/v1",
      modelsUrl: "https://api.navy/v1/models",
      verification: "primary",
      keyOptional: true,
    });
  });
});
