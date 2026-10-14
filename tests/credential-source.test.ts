import { describe, expect, it } from "bun:test";
import {
  classifyProviderCredentialSource,
  collectInlineSecretDoctorChecks,
  isInlinePlaintextApiKey,
  listInlinePlaintextProviders,
  providerHasInlinePlaintextSecret,
  isServiceMode,
  warnInlineProviderSecrets,
  type ProviderCredentialView,
} from "../src/providers/credential-source";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

function base(extra: Partial<ProviderCredentialView> = {}): ProviderCredentialView {
  return {
    authMode: "key",
    ...extra,
  };
}

function makeConfig(
  providers: Record<string, OcxProviderConfig>,
): Pick<OcxConfig, "providers"> {
  return { providers };
}

const emptyEnv: NodeJS.ProcessEnv = {};

describe("credential-source", () => {
  it("classifies env refs as env (both $VAR and ${VAR})", () => {
    expect(classifyProviderCredentialSource(base({ apiKey: "$API_KEY" }))).toBe("env");
    expect(classifyProviderCredentialSource(base({ apiKey: "${API_KEY}" }))).toBe("env");
    expect(isInlinePlaintextApiKey("$API_KEY")).toBe(false);
    expect(isInlinePlaintextApiKey("${API_KEY}")).toBe(false);
  });

  it("classifies leftover plaintext as inline", () => {
    expect(classifyProviderCredentialSource(base({ apiKey: "sk-live-123" }))).toBe("inline");
    expect(providerHasInlinePlaintextSecret(base({ apiKey: "sk-live-123" }))).toBe(true);
  });

  it("prioritises oauth / forward / vault over api keys", () => {
    expect(classifyProviderCredentialSource(base({ authMode: "oauth", apiKey: "sk-live" }))).toBe("oauth");
    expect(classifyProviderCredentialSource(base({ authMode: "forward", apiKey: "sk-live" }))).toBe("forward");
    expect(classifyProviderCredentialSource(base({ credentialRef: "chefvault://x", apiKey: "sk-live" }))).toBe("vault");
  });

  it("detects inline secrets in apiKeyPool", () => {
    const provider = base({
      apiKeyPool: [{ id: "a", key: "$OK" }, { id: "b", key: "plaintext" }],
    });
    expect(providerHasInlinePlaintextSecret(provider)).toBe(true);
  });

  it("detects inline secret in a plaintext-only pool", () => {
    const provider = base({
      apiKeyPool: [{ id: "a", key: "plaintext" }],
    });
    expect(classifyProviderCredentialSource(provider)).toBe("inline");
    expect(providerHasInlinePlaintextSecret(provider)).toBe(true);
  });

  it("lists and sorts inline providers", () => {
    const names = listInlinePlaintextProviders(
      makeConfig({
        zed: { authMode: "key", apiKey: "secret" },
        ok: { authMode: "key", apiKey: "$ENV" },
        alpha: { authMode: "key", apiKey: "also-secret" },
      }),
    );
    expect(names).toEqual(["alpha", "zed"]);
  });

  it("isServiceMode honours 1/true", () => {
    expect(isServiceMode({ OCX_SERVICE: "1" })).toBe(true);
    expect(isServiceMode({ OCX_SERVICE: "true" })).toBe(true);
    expect(isServiceMode({ OCX_SERVICE: "0" })).toBe(false);
    expect(isServiceMode(emptyEnv)).toBe(false);
  });

  it("warnInlineProviderSecrets never echoes secret values", () => {
    const messages: string[] = [];
    const names = warnInlineProviderSecrets(
      makeConfig({ p: { authMode: "key", apiKey: "super-secret-value" } }),
      { warn: (m) => messages.push(m), env: emptyEnv },
    );
    expect(names).toEqual(["p"]);
    expect(messages.join("\n")).not.toContain("super-secret-value");
  });

  it("doctor checks levels", () => {
    const clean = collectInlineSecretDoctorChecks(
      makeConfig({ p: { authMode: "key", apiKey: "$K" } }),
    );
    expect(clean[0].level).toBe("OK");
    const dirty = collectInlineSecretDoctorChecks(
      makeConfig({ p: { authMode: "key", apiKey: "super-secret-value" } }),
    );
    expect(dirty[0].level).toBe("WARN");
    expect(dirty[0].message).not.toContain("super-secret-value");
  });
});
