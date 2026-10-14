import { describe, expect, it, spyOn } from "bun:test";
import {
  classifyProviderCredentialSource,
  collectInlineSecretDoctorChecks,
  formatInlineProviderSecretWarning,
  isInlinePlaintextApiKey,
  listInlinePlaintextProviders,
  providerHasInlinePlaintextSecret,
  isServiceMode,
  warnInlineProviderSecrets,
  type ProviderCredentialView,
} from "../src/providers/credential-source";
import type { OcxConfig } from "../src/types";

function base(
  extra: Partial<ProviderCredentialView> = {},
): ProviderCredentialView {
  return {
    authMode: "key",
    ...extra,
  };
}

function makeConfig(
  providers: Record<string, ProviderCredentialView>,
): Pick<OcxConfig, "providers"> {
  return {
    providers: Object.fromEntries(
      Object.entries(providers).map(([name, provider]) => [
        name,
        {
          adapter: "openai-chat",
          baseUrl: "https://example.test/v1",
          ...provider,
        },
      ]),
    ),
  };
}

const emptyEnv: NodeJS.ProcessEnv = {};

function malformedProvider(
  extra: Record<string, unknown>,
): ProviderCredentialView {
  return { authMode: "key", ...extra } as unknown as ProviderCredentialView;
}

describe("credential-source", () => {
  it("classifies env refs as env (both $VAR and ${VAR})", () => {
    expect(classifyProviderCredentialSource(base({ apiKey: "$API_KEY" }))).toBe(
      "env",
    );
    expect(
      classifyProviderCredentialSource(base({ apiKey: "${API_KEY}" })),
    ).toBe("env");
    expect(isInlinePlaintextApiKey("$API_KEY")).toBe(false);
    expect(isInlinePlaintextApiKey("${API_KEY}")).toBe(false);
  });

  it("classifies leftover plaintext as inline", () => {
    expect(
      classifyProviderCredentialSource(base({ apiKey: "sk-live-123" })),
    ).toBe("inline");
    expect(
      providerHasInlinePlaintextSecret(base({ apiKey: "sk-live-123" })),
    ).toBe(true);
  });

  it("prioritises oauth / forward / vault over api keys", () => {
    expect(
      classifyProviderCredentialSource(
        base({ authMode: "oauth", apiKey: "sk-live" }),
      ),
    ).toBe("oauth");
    expect(
      classifyProviderCredentialSource(
        base({ authMode: "forward", apiKey: "sk-live" }),
      ),
    ).toBe("forward");
    expect(
      classifyProviderCredentialSource(
        base({ credentialRef: "chefvault://x", apiKey: "sk-live" }),
      ),
    ).toBe("vault");
  });

  it("detects inline secrets in apiKeyPool", () => {
    const provider = base({
      apiKeyPool: [
        { id: "a", key: "$OK" },
        { id: "b", key: "plaintext" },
      ],
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

  it("treats malformed credential fields as absent instead of throwing", () => {
    const invalidApiKey = malformedProvider({ apiKey: 123 });
    expect(() => classifyProviderCredentialSource(invalidApiKey)).not.toThrow();
    expect(classifyProviderCredentialSource(invalidApiKey)).toBeUndefined();
    expect(providerHasInlinePlaintextSecret(invalidApiKey)).toBe(false);

    const invalidPool = malformedProvider({ apiKeyPool: { key: "ignored" } });
    expect(() => classifyProviderCredentialSource(invalidPool)).not.toThrow();
    expect(classifyProviderCredentialSource(invalidPool)).toBeUndefined();
    expect(providerHasInlinePlaintextSecret(invalidPool)).toBe(false);
  });

  it("skips null and non-object pool entries but still classifies valid string keys", () => {
    const provider = malformedProvider({
      apiKeyPool: [null, 7, { key: 42 }, { key: "fixture-inline-key" }],
    });
    expect(() => classifyProviderCredentialSource(provider)).not.toThrow();
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

  describe("missing credentials and precedence", () => {
    it.each([
      {},
      { apiKey: "" },
      { apiKeyPool: [] },
      { apiKey: "", apiKeyPool: [{ id: "empty", key: "" }] },
      { credentialRef: " \t\n " },
    ] satisfies ProviderCredentialView[])(
      "has no source or inline secret for %j",
      (extra) => {
        const provider = base(extra);
        expect(classifyProviderCredentialSource(provider)).toBeUndefined();
        expect(providerHasInlinePlaintextSecret(provider)).toBe(false);
      },
    );

    it.each([undefined, "", "$KEY", "${KEY}"])(
      "does not treat %j as plaintext",
      (value) => {
        expect(isInlinePlaintextApiKey(value)).toBe(false);
      },
    );

    it.each(["fixture-inline-key", "prefix$KEY", "prefix${KEY}"])(
      "treats non-reference value %j as plaintext",
      (value) => {
        expect(isInlinePlaintextApiKey(value)).toBe(true);
      },
    );

    it.each(["oauth", "forward"] as const)(
      "%s overrides vault and keys but still reports leftover plaintext",
      (authMode) => {
        const provider = base({
          authMode,
          credentialRef: "chefvault://fixture/provider",
          apiKey: "$KEY",
          apiKeyPool: [{ id: "inactive", key: "fixture-leftover" }],
        });
        expect(classifyProviderCredentialSource(provider)).toBe(authMode);
        expect(providerHasInlinePlaintextSecret(provider)).toBe(true);
      },
    );

    it("uses a trimmed non-empty vault reference before env or pool keys", () => {
      expect(
        classifyProviderCredentialSource(
          base({
            credentialRef: "  chefvault://fixture/provider  ",
            apiKey: "$KEY",
            apiKeyPool: [{ id: "inactive", key: "fixture-inline" }],
          }),
        ),
      ).toBe("vault");
      expect(
        classifyProviderCredentialSource(
          base({
            credentialRef: " \t ",
            apiKey: "$KEY",
          }),
        ),
      ).toBe("env");
    });

    it("classifies the primary key before the pool without hiding pool secrets", () => {
      const envPrimary = base({
        apiKey: "$ACTIVE_KEY",
        apiKeyPool: [{ id: "inactive", key: "fixture-pool-secret" }],
      });
      expect(classifyProviderCredentialSource(envPrimary)).toBe("env");
      expect(providerHasInlinePlaintextSecret(envPrimary)).toBe(true);
      expect(
        classifyProviderCredentialSource(
          base({
            apiKey: "fixture-primary-secret",
            apiKeyPool: [{ id: "env", key: "$POOL_KEY" }],
          }),
        ),
      ).toBe("inline");
    });

    it.each([
      ["$POOL_KEY", "fixture-pool-secret"],
      ["fixture-pool-secret", "${POOL_KEY}"],
    ])(
      "classifies a mixed pool as env regardless of order: %j, %j",
      (first, second) => {
        const provider = base({
          apiKeyPool: [
            { id: "a", key: first },
            { id: "b", key: second },
          ],
        });
        expect(classifyProviderCredentialSource(provider)).toBe("env");
        expect(providerHasInlinePlaintextSecret(provider)).toBe(true);
      },
    );

    it("accepts an env-only pool without resolving environment variables", () => {
      const provider = base({
        apiKey: "",
        apiKeyPool: [
          { id: "empty", key: "" },
          { id: "a", key: "$OCX_CREDENTIAL_SOURCE_FIXTURE" },
          { id: "b", key: "${OCX_CREDENTIAL_SOURCE_FIXTURE}" },
        ],
      });
      expect(classifyProviderCredentialSource(provider)).toBe("env");
      expect(providerHasInlinePlaintextSecret(provider)).toBe(false);
    });
  });

  describe("service mode", () => {
    it.each([" 1 ", "\ttrue\n"])("trims the enabled value %j", (value) => {
      expect(isServiceMode({ OCX_SERVICE: value })).toBe(true);
    });

    it.each(["", " ", "false", "TRUE", "True", "yes", "2"])(
      "does not enable service mode for %j",
      (value) => {
        expect(isServiceMode({ OCX_SERVICE: value })).toBe(false);
      },
    );

    it("defaults to process.env for service detection and warnings", () => {
      const previous = process.env.OCX_SERVICE;
      try {
        process.env.OCX_SERVICE = " true ";
        expect(isServiceMode()).toBe(true);
        const messages: string[] = [];
        warnInlineProviderSecrets(
          makeConfig({ p: base({ apiKey: "fixture-secret" }) }),
          {
            warn: (message) => messages.push(message),
          },
        );
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain("service env");
      } finally {
        if (previous === undefined) delete process.env.OCX_SERVICE;
        else process.env.OCX_SERVICE = previous;
      }
    });
  });

  describe("diagnostics", () => {
    it.each([false, true])(
      "formats actionable warnings for serviceMode=%j",
      (serviceMode) => {
        const message = formatInlineProviderSecretWarning(
          ["alpha", "zed"],
          serviceMode,
        );
        expect(message).toContain("alpha, zed");
        expect(message).toContain("config.json");
        expect(message).toContain("$VAR");
        expect(message).toContain("${VAR}");
        expect(message).toContain(
          serviceMode
            ? "service env"
            : "Local ocx start still accepts inline keys",
        );
      },
    );

    it("returns no warning for safe credentials or an empty provider set", () => {
      const config = makeConfig({
        env: base({ apiKey: "$KEY" }),
        pool: base({ apiKeyPool: [{ id: "a", key: "${KEY}" }] }),
        oauth: base({ authMode: "oauth" }),
        forward: base({ authMode: "forward" }),
        vault: base({ credentialRef: "chefvault://fixture/provider" }),
        empty: base(),
      });
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(warnInlineProviderSecrets(config, { env: emptyEnv })).toEqual(
          [],
        );
        expect(
          warnInlineProviderSecrets(makeConfig({}), { env: emptyEnv }),
        ).toEqual([]);
        expect(warn).not.toHaveBeenCalled();
        expect(collectInlineSecretDoctorChecks(config)).toEqual([
          expect.objectContaining({
            level: "OK",
            message: expect.stringContaining("No plaintext"),
          }),
        ]);
        expect(collectInlineSecretDoctorChecks(makeConfig({}))[0].level).toBe(
          "OK",
        );
      } finally {
        warn.mockRestore();
      }
    });

    it("warns once through console.warn when no callback is provided", () => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const names = warnInlineProviderSecrets(
          makeConfig({
            p: base({ apiKey: "fixture-console-secret" }),
          }),
          { env: { OCX_SERVICE: "1" } },
        );
        expect(names).toEqual(["p"]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain("service env");
        expect(warn.mock.calls[0][0]).not.toContain("fixture-console-secret");
      } finally {
        warn.mockRestore();
      }
    });

    it("reports sorted provider names once without exposing keys, refs or labels or mutating config", () => {
      const secrets = [
        "fixture-primary-secret",
        "fixture-pool-secret",
        "fixture-oauth-leftover",
      ];
      const config = makeConfig({
        zed: base({
          apiKey: secrets[0],
          apiKeyPool: [
            {
              id: "fixture-id",
              key: secrets[1],
              label: "fixture-private-label",
            },
          ],
        }),
        alpha: base({ authMode: "oauth", apiKey: secrets[2] }),
        vault: base({ credentialRef: "chefvault://fixture-private-ref" }),
        safe: base({ apiKey: "$KEY" }),
      });
      const before = JSON.stringify(config);
      const messages: string[] = [];
      expect(listInlinePlaintextProviders(config)).toEqual(["alpha", "zed"]);
      expect(
        warnInlineProviderSecrets(config, {
          env: emptyEnv,
          warn: (message) => messages.push(message),
        }),
      ).toEqual(["alpha", "zed"]);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("alpha, zed");
      const checks = collectInlineSecretDoctorChecks(config);
      expect(checks).toEqual([
        expect.objectContaining({
          level: "WARN",
          message: expect.stringContaining("alpha, zed"),
        }),
      ]);
      expect(checks[0].message).toContain("EnvironmentFile");
      const diagnostics = JSON.stringify({ messages, checks });
      for (const value of [
        ...secrets,
        "fixture-id",
        "fixture-private-label",
        "fixture-private-ref",
      ]) {
        expect(diagnostics).not.toContain(value);
      }
      expect(JSON.stringify(config)).toBe(before);
    });
  });
});
