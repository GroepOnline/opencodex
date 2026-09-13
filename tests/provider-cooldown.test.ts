import { afterEach, describe, expect, test } from "bun:test";
import {
  acquireProviderFamilyAdmission,
  clearProviderFamilyCooldownsForTests,
  coolProviderFamilyAfter429,
  isProviderFamilyCooling,
  providerCooldownFamily,
  providerFamilyCooldownCountForTests,
  settleProviderFamilyRecovery,
} from "../src/providers/provider-cooldown";
import type { OcxConfig } from "../src/types";

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "azure-a",
    providers: {
      "azure-a": {
        adapter: "openai-chat",
        baseUrl: "https://first.services.ai.azure.com/models",
      },
      "azure-b": {
        adapter: "openai-chat",
        baseUrl: "https://first.services.ai.azure.com/other-deployment",
      },
      "azure-other-resource": {
        adapter: "openai-chat",
        baseUrl: "https://second.services.ai.azure.com/models",
      },
      direct: {
        adapter: "azure-openai",
        baseUrl: "https://example.test/openai",
      },
      other: {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
      },
    },
  } as OcxConfig;
}

afterEach(() => clearProviderFamilyCooldownsForTests());

describe("provider-family cooldown", () => {
  test("classifies Azure by name, adapter, or canonical hostname", () => {
    const cfg = config();
    expect(providerCooldownFamily("azure-a", cfg.providers["azure-a"])).toBe("azure:first.services.ai.azure.com");
    expect(providerCooldownFamily("direct", cfg.providers.direct)).toBe("azure:example.test");
    expect(providerCooldownFamily("other", cfg.providers.other)).toBeNull();
  });

  test("one Azure 429 cools sibling routes on the same resource for Retry-After", () => {
    const cfg = config();
    const now = 1_000;
    coolProviderFamilyAfter429(cfg, "azure-a", "120", now);
    expect(isProviderFamilyCooling(cfg, "azure-a", now + 60_000)).toBe(true);
    expect(isProviderFamilyCooling(cfg, "azure-b", now + 60_000)).toBe(true);
    expect(isProviderFamilyCooling(cfg, "azure-other-resource", now + 60_000)).toBe(false);
    expect(isProviderFamilyCooling(cfg, "other", now + 60_000)).toBe(false);
    const recovery = acquireProviderFamilyAdmission(cfg, "azure-b", now + 120_000);
    expect(recovery.allowed).toBe(true);
    expect(recovery.allowed && recovery.recoveryLease).toBeDefined();
  });

  test("missing Retry-After uses the bounded default cooldown", () => {
    const cfg = config();
    const now = 1_000;
    coolProviderFamilyAfter429(cfg, "azure-a", null, now);
    expect(isProviderFamilyCooling(cfg, "azure-b", now + 59_999)).toBe(true);
    const recovery = acquireProviderFamilyAdmission(cfg, "azure-b", now + 60_000);
    expect(recovery.allowed).toBe(true);
    expect(recovery.allowed && recovery.recoveryLease).toBeDefined();
  });

  test("serializes one Azure recovery probe after cooldown expiry", () => {
    const cfg = config();
    const now = 1_000;
    coolProviderFamilyAfter429(cfg, "azure-a", "60", now);

    const first = acquireProviderFamilyAdmission(cfg, "azure-a", now + 60_000);
    expect(first.allowed).toBe(true);
    expect(first.allowed && first.recoveryLease).toBeDefined();
    expect(acquireProviderFamilyAdmission(cfg, "azure-b", now + 60_000)).toEqual({
      allowed: false,
    });
    expect(isProviderFamilyCooling(cfg, "azure-b", now + 60_000)).toBe(true);

    if (!first.allowed) throw new Error("expected recovery lease");
    settleProviderFamilyRecovery(first.recoveryLease, true);
    expect(isProviderFamilyCooling(cfg, "azure-b", now + 60_001)).toBe(false);
    expect(acquireProviderFamilyAdmission(cfg, "azure-b", now + 60_001)).toEqual({
      allowed: true,
    });
  });

  test("releases a failed recovery lease without clearing the cooldown state", () => {
    const cfg = config();
    const now = 1_000;
    coolProviderFamilyAfter429(cfg, "azure-a", "60", now);

    const first = acquireProviderFamilyAdmission(cfg, "azure-a", now + 60_000);
    if (!first.allowed) throw new Error("expected recovery lease");
    settleProviderFamilyRecovery(first.recoveryLease, false);

    const retry = acquireProviderFamilyAdmission(cfg, "azure-b", now + 60_001);
    expect(retry.allowed).toBe(true);
    expect(retry.allowed && retry.recoveryLease).toBeDefined();
  });

  test("prunes expired dormant families under provider churn", () => {
    const cfg = config();
    for (let i = 0; i < 1_100; i++) {
      const providerName = `azure-churn-${i}`;
      cfg.providers[providerName] = {
        adapter: "openai-chat",
        baseUrl: `https://resource-${i}.services.ai.azure.com/models`,
      };
      coolProviderFamilyAfter429(cfg, providerName, "1", 1_000);
    }
    expect(providerFamilyCooldownCountForTests()).toBeGreaterThan(1_024);

    coolProviderFamilyAfter429(cfg, "azure-a", "60", 700_001);
    expect(providerFamilyCooldownCountForTests()).toBe(1);
    expect(isProviderFamilyCooling(cfg, "azure-a", 700_001)).toBe(true);
  });

  test("never prunes a live recovery lease while cleaning dormant entries", () => {
    const cfg = config();
    coolProviderFamilyAfter429(cfg, "azure-a", "1", 1_000);
    const recovery = acquireProviderFamilyAdmission(cfg, "azure-a", 2_000);
    expect(recovery.allowed && recovery.recoveryLease).toBeDefined();

    for (let i = 0; i < 1_030; i++) {
      const providerName = `azure-dormant-${i}`;
      cfg.providers[providerName] = {
        adapter: "openai-chat",
        baseUrl: `https://dormant-${i}.services.ai.azure.com/models`,
      };
      coolProviderFamilyAfter429(cfg, providerName, "1", 1_000);
    }
    cfg.providers.trigger = {
      adapter: "azure-openai",
      baseUrl: "https://trigger.test/openai",
    };
    coolProviderFamilyAfter429(cfg, "trigger", "1", 3_000);

    expect(acquireProviderFamilyAdmission(cfg, "azure-b", 3_000)).toEqual({
      allowed: false,
    });
  });
});
