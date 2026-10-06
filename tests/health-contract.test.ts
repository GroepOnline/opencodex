import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANAGEMENT_CONTRACT_VERSION } from "../src/server/contract-version";
import { buildHealthContract } from "../src/server/health-contract";
import { saveCredential } from "../src/oauth/store";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const previousHome = process.env.OPENCODEX_HOME;
let testHome = "";

function oauthProvider(over: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    authMode: "oauth",
    models: ["model-test"],
    ...over,
  };
}

function keyProvider(over: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    apiKey: "sk-test",
    models: ["gpt-test"],
    ...over,
  };
}

function configWith(providers: OcxConfig["providers"]): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: Object.keys(providers)[0] ?? "demo",
    providers,
  };
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-health-contract-"));
  process.env.OPENCODEX_HOME = testHome;
  writeFileSync(join(testHome, "config.json"), "{}\n", "utf8");
  writeFileSync(join(testHome, "usage.jsonl"), "", "utf8");
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = "";
});

describe("buildHealthContract provider credentials", () => {
  test("oauth provider with no auth.json is degraded (missing credentials)", () => {
    const health = buildHealthContract(configWith({
      "google-antigravity": oauthProvider(),
      "github-copilot": oauthProvider(),
    }), {
      managementAuthAvailable: true,
      contractVersion: MANAGEMENT_CONTRACT_VERSION,
    });

    expect(health.components.providers).toEqual([
      expect.objectContaining({
        name: "google-antigravity",
        disabled: false,
        status: "degraded",
        message: expect.stringMatching(/missing credentials/i),
      }),
      expect.objectContaining({
        name: "github-copilot",
        disabled: false,
        status: "degraded",
        message: expect.stringMatching(/missing credentials/i),
      }),
    ]);
    expect(health.causality.some(entry =>
      entry.component === "provider:google-antigravity" && /missing credentials/i.test(entry.reason),
    )).toBe(true);
    expect(health.status).toBe("degraded");
  });

  test("oauth provider with empty auth.json accounts is degraded", () => {
    writeFileSync(join(testHome, "auth.json"), JSON.stringify({
      "google-antigravity": { activeAccountId: "", accounts: [] },
      "github-copilot": { accounts: [] },
    }), "utf8");

    const health = buildHealthContract(configWith({
      "google-antigravity": oauthProvider(),
    }), {
      managementAuthAvailable: true,
      contractVersion: MANAGEMENT_CONTRACT_VERSION,
    });

    const provider = health.components.providers.find(p => p.name === "google-antigravity");
    expect(provider).toMatchObject({
      status: "degraded",
      message: expect.stringMatching(/missing credentials/i),
    });
  });

  test("oauth provider with a stored account can be ok", async () => {
    await saveCredential("google-antigravity", {
      access: "ya29.test-access",
      refresh: "1//test-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "acct-1",
    });

    const health = buildHealthContract(configWith({
      "google-antigravity": oauthProvider(),
    }), {
      managementAuthAvailable: true,
      contractVersion: MANAGEMENT_CONTRACT_VERSION,
    });

    expect(health.components.providers[0]).toMatchObject({
      name: "google-antigravity",
      status: "ok",
      message: "configured",
    });
    expect(health.causality.some(entry => entry.component === "provider:google-antigravity")).toBe(false);
  });

  test("apiKey provider still reports ok without oauth store", () => {
    const health = buildHealthContract(configWith({
      demo: keyProvider(),
    }), {
      managementAuthAvailable: true,
      contractVersion: MANAGEMENT_CONTRACT_VERSION,
    });

    expect(health.components.providers[0]).toMatchObject({
      name: "demo",
      status: "ok",
      message: "configured",
    });
  });

  test("forward authMode still counts as configured without apiKey or auth.json", () => {
    const health = buildHealthContract(configWith({
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authMode: "forward",
        models: ["gpt-5"],
      },
    }), {
      managementAuthAvailable: true,
      contractVersion: MANAGEMENT_CONTRACT_VERSION,
    });

    expect(health.components.providers[0]).toMatchObject({
      name: "openai",
      status: "ok",
      message: "configured",
    });
  });

  test("oauth authMode is not itself a credential even when an apiKey sibling is ok", () => {
    const health = buildHealthContract(configWith({
      demo: keyProvider(),
      "github-copilot": oauthProvider(),
    }), {
      managementAuthAvailable: true,
      contractVersion: MANAGEMENT_CONTRACT_VERSION,
    });

    expect(health.components.providers.find(p => p.name === "demo")?.status).toBe("ok");
    expect(health.components.providers.find(p => p.name === "github-copilot")).toMatchObject({
      status: "degraded",
      message: expect.stringMatching(/missing credentials/i),
    });
  });
});
