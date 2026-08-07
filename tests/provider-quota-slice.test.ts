import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAccountQuota } from "../src/codex/quota";
import { saveCredential } from "../src/oauth/store";
import { clearProviderQuotaCache, fetchProviderQuotaReport } from "../src/providers/quota";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const previousCodexHome = process.env.CODEX_HOME;

let opencodexHome: string;
let codexHome: string;

/** Per-provider slice probes (`/api/provider-quotas?provider=<name>`): the card-level
    fan-out must distinguish "no quota API" from "probe failed", and never leak either
    into the aggregate path. */
function testConfig(): OcxConfig {
  return {
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-chat",
        authMode: "oauth",
        baseUrl: "https://api.x.ai/v1",
      },
      openrouter: {
        adapter: "openai-chat",
        authMode: "key",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-test-key",
      },
      disabled_xai: {
        adapter: "openai-chat",
        authMode: "oauth",
        baseUrl: "https://api.x.ai/v1",
        disabled: true,
      },
    },
  } as OcxConfig;
}

beforeEach(() => {
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-quota-slice-"));
  codexHome = mkdtempSync(join(tmpdir(), "codex-quota-slice-"));
  process.env.OPENCODEX_HOME = opencodexHome;
  process.env.CODEX_HOME = codexHome;
  clearAccountQuota();
  clearProviderQuotaCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAccountQuota();
  clearProviderQuotaCache();
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  rmSync(opencodexHome, { recursive: true, force: true });
  rmSync(codexHome, { recursive: true, force: true });
});

describe("fetchProviderQuotaReport (per-provider slice)", () => {
  test("key-only providers without a quota API are unsupported, never an error", async () => {
    const res = await fetchProviderQuotaReport(testConfig(), "openrouter");
    expect(res.reports).toEqual([]);
    expect(res.unsupported).toBe(true);
    expect(res.error).toBeUndefined();
  });

  test("disabled providers are unsupported without probing upstream", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => { fetchCount += 1; return new Response("{}", { status: 200 }); }) as typeof fetch;
    const res = await fetchProviderQuotaReport(testConfig(), "disabled_xai");
    expect(res.reports).toEqual([]);
    expect(res.unsupported).toBe(true);
    expect(res.error).toBeUndefined();
    expect(fetchCount).toBe(0);
  });

  test("a failed probe surfaces error instead of being mistaken for unsupported", async () => {
    // No credential seeded: the xai probe applies but cannot produce a report.
    const res = await fetchProviderQuotaReport(testConfig(), "xai");
    expect(res.reports).toEqual([]);
    expect(res.error).toBe("quota-probe-failed");
    expect(res.unsupported).toBeUndefined();
  });

  test("a successful probe returns exactly one report, without error or unsupported", async () => {
    await saveCredential("xai", { access: "xai-access-secret", refresh: "xai-refresh-secret", expires: Date.now() + 3600_000 });
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url === "https://cli-chat-proxy.grok.com/v1/billing") {
        return new Response(JSON.stringify({
          config: { monthlyLimit: { val: 10_000 }, used: { val: 2_500 }, billingPeriodEnd: "2026-08-31T00:00:00Z" },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const res = await fetchProviderQuotaReport(testConfig(), "xai");
    expect(res.error).toBeUndefined();
    expect(res.unsupported).toBeUndefined();
    expect(res.reports.length).toBe(1);
    expect(res.reports[0]!.provider).toBe("xai");
    expect(seen).toEqual(["https://cli-chat-proxy.grok.com/v1/billing"]);
  });

  test("unknown provider throws so the route can answer 404", async () => {
    await expect(fetchProviderQuotaReport(testConfig(), "nope")).rejects.toThrow("unknown provider: nope");
  });

  test("inherited properties like constructor are rejected with 404", async () => {
    await expect(fetchProviderQuotaReport(testConfig(), "constructor")).rejects.toThrow("unknown provider: constructor");
  });
});
