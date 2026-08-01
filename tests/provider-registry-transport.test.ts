import { afterEach, describe, expect, it } from "bun:test";
import { getProviderRegistryEntry, providerMatchesRegistryTransport } from "../src/providers/registry";
import type { ProviderRegistryEntry } from "../src/providers/registry";

/**
 * `providerMatchesRegistryTransport` decides whether registry transport defaults
 * own a configured row, which gates both replacing a stored key provider's
 * destination and trusting registry model-discovery metadata for it. No shipped
 * entry opts into `preserveCustomDestination` yet, so the collision-preserving
 * branches are exercised by flipping the flag on a real entry and restoring it.
 */
describe("providerMatchesRegistryTransport", () => {
  const patched: { entry: Record<string, unknown>; key: string; had: boolean; value: unknown }[] = [];

  /** Temporarily set a registry field, restoring the entry after the test. */
  function patch(id: string, key: keyof ProviderRegistryEntry, value: unknown): ProviderRegistryEntry {
    const entry = getProviderRegistryEntry(id);
    if (!entry) throw new Error(`missing registry entry: ${id}`);
    const mutable = entry as unknown as Record<string, unknown>;
    patched.push({ entry: mutable, key, had: key in mutable, value: mutable[key] });
    mutable[key] = value;
    return entry;
  }

  afterEach(() => {
    for (const { entry, key, had, value } of patched.reverse()) {
      if (had) entry[key] = value;
      else delete entry[key];
    }
    patched.length = 0;
  });

  it("does not claim rows for an unknown provider id", () => {
    expect(providerMatchesRegistryTransport("not-a-provider", {
      baseUrl: "https://api.groq.com/openai/v1",
      adapter: "openai-chat",
    })).toBe(false);
  });

  it("keeps historical pinning for key presets that did not opt in", () => {
    const groq = getProviderRegistryEntry("groq")!;
    expect(groq.preserveCustomDestination).toBeUndefined();
    expect(providerMatchesRegistryTransport("groq", {
      baseUrl: "https://someone-elses-host.example.test/v1",
      adapter: "openai-chat",
    })).toBe(true);
  });

  it("keeps oauth providers pinned regardless of the configured destination", () => {
    expect(providerMatchesRegistryTransport("google-antigravity", {
      baseUrl: "https://someone-elses-host.example.test",
      adapter: "google",
    })).toBe(true);
  });

  describe("with preserveCustomDestination", () => {
    /** groq is a fixed key destination: no template, no base-URL override. */
    function optInGroq(): ProviderRegistryEntry {
      return patch("groq", "preserveCustomDestination", true);
    }

    it("owns a row that still points at the fixed registry endpoint", () => {
      const groq = optInGroq();
      expect(providerMatchesRegistryTransport("groq", {
        baseUrl: groq.baseUrl,
        adapter: groq.adapter,
      })).toBe(true);
    });

    it("treats trailing-slash variants as the same endpoint", () => {
      const groq = optInGroq();
      expect(providerMatchesRegistryTransport("groq", {
        baseUrl: `${groq.baseUrl}/`,
        adapter: groq.adapter,
      })).toBe(true);
      expect(providerMatchesRegistryTransport("groq", {
        baseUrl: `  ${groq.baseUrl}///  `,
        adapter: groq.adapter,
      })).toBe(true);
    });

    it("releases a row pointed at a different endpoint", () => {
      const groq = optInGroq();
      expect(providerMatchesRegistryTransport("groq", {
        baseUrl: "https://api.groq.com.example.test/openai/v1",
        adapter: groq.adapter,
      })).toBe(false);
      expect(providerMatchesRegistryTransport("groq", {
        baseUrl: "https://api.groq.com/openai/v2",
        adapter: groq.adapter,
      })).toBe(false);
    });

    it("releases a row whose adapter or auth mode diverges", () => {
      const groq = optInGroq();
      expect(providerMatchesRegistryTransport("groq", {
        baseUrl: groq.baseUrl,
        adapter: "anthropic",
      })).toBe(false);
      expect(providerMatchesRegistryTransport("groq", {
        baseUrl: groq.baseUrl,
        adapter: groq.adapter,
        authMode: "oauth",
      })).toBe(false);
      expect(providerMatchesRegistryTransport("groq", {
        baseUrl: groq.baseUrl,
        adapter: groq.adapter,
        authMode: "key",
      })).toBe(true);
    });

    it("releases a row with a missing base URL", () => {
      const groq = optInGroq();
      expect(providerMatchesRegistryTransport("groq", {
        adapter: groq.adapter,
      })).toBe(false);
    });

    it("fails closed when the opt-in is combined with a base-URL override", () => {
      const groq = optInGroq();
      patch("groq", "allowBaseUrlOverride", true);
      expect(providerMatchesRegistryTransport("groq", {
        baseUrl: groq.baseUrl,
        adapter: groq.adapter,
      })).toBe(false);
    });

    it("fails closed when the opt-in is combined with a templated base URL", () => {
      const azure = patch("azure-openai", "preserveCustomDestination", true);
      expect(azure.baseUrl).toContain("{resource}");
      expect(providerMatchesRegistryTransport("azure-openai", {
        baseUrl: azure.baseUrl,
        adapter: azure.adapter,
      })).toBe(false);
      expect(providerMatchesRegistryTransport("azure-openai", {
        baseUrl: "https://acme.openai.azure.com/openai",
        adapter: azure.adapter,
      })).toBe(false);
    });
  });
});
