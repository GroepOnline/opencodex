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

function base(extra: Partial<Omit<ProviderCredentialView, never>> = {}): ProviderCredentialView {
  return {
    authMode: "key",
    ...extra,
  } as ProviderCredentialView;
}

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
    const names = listInlinePlaintextProviders({
      providers: {
        zed: { authMode: "key", apiKey: "secret" } as any,
        ok: { authMode: "key", apiKey: "$ENV" } as any,
        alpha: { authMode: "key", apiKey: "also-secret" } as any,
      },
    } as any);
    expect(names).toEqual(["alpha", "zed"]);
  });

  it("isServiceMode honours 1/true", () => {
    expect(isServiceMode({ OCX_SERVICE: "1" } as any)).toBe(true);
    expect(isServiceMode({ OCX_SERVICE: "true" } as any)).toBe(true);
    expect(isServiceMode({ OCX_SERVICE: "0" } as any)).toBe(false);
    expect(isServiceMode({} as any)).toBe(false);
  });

  it("warnInlineProviderSecrets never echoes secret values", () => {
    const messages: string[] = [];
    const names = warnInlineProviderSecrets(
      { providers: { p: { authMode: "key", apiKey: "super-secret-value" } as any } } as any,
      { warn: (m) => messages.push(m), env: {} },
    );
    expect(names).toEqual(["p"]);
    expect(messages.join("\n")).not.toContain("super-secret-value");
  });

  it("doctor checks levels", () => {
    const clean = collectInlineSecretDoctorChecks({
      providers: { p: { authMode: "key", apiKey: "$K" } as any },
    } as any);
    expect(clean[0].level).toBe("OK");
    const dirty = collectInlineSecretDoctorChecks({
      providers: { p: { authMode: "key", apiKey: "super-secret-value" } as any },
    } as any);
    expect(dirty[0].level).toBe("WARN");
    expect(dirty[0].message).not.toContain("super-secret-value");
  });
});
