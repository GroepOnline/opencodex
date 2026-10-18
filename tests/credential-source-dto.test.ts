import { describe, expect, it } from "bun:test";
import { safeConfigDTO } from "../src/server/auth-cors";
import type { OcxConfig } from "../src/types";

function baseConfig(providers: OcxConfig["providers"]): OcxConfig {
  return {
    providers,
  } as OcxConfig;
}

describe("safeConfigDTO credential-source surface", () => {
  it("classifies provider credentials without echoing secret values", () => {
    const secret = "sk-super-secret-value";
    const dto = safeConfigDTO(
      baseConfig({
        inlineProvider: {
          adapter: "openai-chat",
          baseUrl: "https://example.invalid",
          apiKey: secret,
          authMode: "key",
        },
        envProvider: {
          adapter: "openai-chat",
          baseUrl: "https://example.invalid",
          apiKey: "$OPENAI_API_KEY",
          authMode: "key",
        },
      }),
    ) as {
      providers: Record<string, { hasApiKey?: boolean; credentialSource?: string }>;
      inlineProviderSecrets: string[];
    };

    expect(dto.providers["inlineProvider"]!.hasApiKey).toBe(true);
    expect(dto.providers["inlineProvider"]!.credentialSource).toBe("inline");
    expect(dto.providers["envProvider"]!.credentialSource).toBe("env");
    expect(dto.inlineProviderSecrets).toEqual(["inlineProvider"]);
    expect(JSON.stringify(dto)).not.toContain(secret);
  });

  it("does not list env-ref or vault providers as inline defects", () => {
    const dto = safeConfigDTO(
      baseConfig({
        envProvider: {
          adapter: "openai-chat",
          baseUrl: "https://example.invalid",
          apiKey: "${OPENAI_API_KEY}",
          authMode: "key",
        },
        vaultProvider: {
          adapter: "openai-chat",
          baseUrl: "https://example.invalid",
          authMode: "key",
          credentialRef: "chefvault://secret",
        },
      }),
    ) as {
      inlineProviderSecrets: string[];
      providers: Record<string, { credentialSource?: string }>;
    };

    expect(dto.inlineProviderSecrets).toEqual([]);
    expect(dto.providers["envProvider"]!.credentialSource).toBe("env");
    expect(dto.providers["vaultProvider"]!.credentialSource).toBe("vault");
  });
});
