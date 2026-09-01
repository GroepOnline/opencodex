import { describe, expect, test } from "bun:test";
import {
  externalOcxManagementOrigin,
  syncExternalOcxCatalog,
} from "../src/codex/external-ocx-catalog";

function config(baseUrl = "http://127.0.0.1:10100/v1"): string {
  return [
    'model_catalog_json = "/wrong/home/opencodex-catalog.json"',
    'model_provider = "ocxgw"',
    "",
    "[model_providers.ocxgw]",
    `base_url = "${baseUrl}"`,
    'wire_api = "responses"',
    "",
  ].join("\n");
}

function nativeCatalog() {
  return {
    models: [{
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      description: "native",
      base_instructions: "You are Codex.",
      supported_reasoning_levels: [
        { effort: "low", description: "low" },
        { effort: "medium", description: "medium" },
      ],
    }],
  };
}
describe("externalOcxManagementOrigin", () => {
  test("accepts only a loopback external provider ending in /v1", () => {
    expect(externalOcxManagementOrigin(config())).toBe("http://127.0.0.1:10100");
    expect(externalOcxManagementOrigin(config("http://localhost:10100/v1/"))).toBe("http://localhost:10100");
    expect(externalOcxManagementOrigin(config("https://ocx.example.test/v1"))).toBeNull();
    expect(externalOcxManagementOrigin(config("http://127.0.0.1:10100/other"))).toBeNull();
  });

  test("does not claim arbitrary external providers without an OCX-shaped loopback endpoint", () => {
    const text = [
      'model_provider = "custom"',
      "[model_providers.custom]",
      'base_url = "https://example.test/v1"',
    ].join("\n");
    expect(externalOcxManagementOrigin(text)).toBeNull();
  });
});

describe("syncExternalOcxCatalog", () => {
  test("identity-checks loopback before attaching admin auth and writes only active models", async () => {
    const requests: Array<{ url: string; key: string | null }> = [];
    let catalog = "";
    let writtenConfig = "";
    const result = await syncExternalOcxCatalog({
      readConfig: () => config(),
      adminToken: () => `ocx_admin_${"a".repeat(43)}`,
      catalogPath: "/tmp/client/opencodex-catalog.json",
      loadCatalog: () => nativeCatalog(),
      invalidateCache: () => true,
      writeCatalog: (_path, content) => { catalog = content; },
      writeConfig: content => { writtenConfig = content; },
      fetchImpl: (async (input, init) => {
        const url = String(input);
        const key = new Headers(init?.headers).get("x-opencodex-api-key");
        requests.push({ url, key });
        if (url.endsWith("/healthz")) {
          return Response.json({ status: "ok", service: "opencodex" });
        }
        if (url.endsWith("/api/subagent-models")) {
          return Response.json({ chosen: ["combo/factory"] });
        }
        return Response.json([
          { provider: "combo", id: "factory", namespaced: "combo/factory", disabled: false, parallelToolCalls: true },
          { provider: "azure-foundry", id: "DeepSeek-V4-Flash-0731", namespaced: "azure-foundry/DeepSeek-V4-Flash-0731", disabled: false, contextWindow: 128000 },
          { provider: "stale", id: "hidden", namespaced: "stale/hidden", disabled: true },
        ]);
      }) as typeof fetch,
    });
    expect(result).toEqual({
      handled: true,
      catalogPath: "/tmp/client/opencodex-catalog.json",
      models: 2,
      cacheSynced: true,
    });
    expect(requests[0]).toEqual({ url: "http://127.0.0.1:10100/healthz", key: null });
    expect(requests.slice(1).every(request => request.key?.startsWith("ocx_admin_") === true)).toBe(true);
    expect(catalog).toContain('"slug": "combo/factory"');
    expect(catalog).toContain('"slug": "azure-foundry/DeepSeek-V4-Flash-0731"');
    expect(catalog).not.toContain("stale/hidden");
    expect(writtenConfig).toContain('model_catalog_json = "/tmp/client/opencodex-catalog.json"');
  });

  test("a foreign loopback responder never receives the admin bearer", async () => {
    const requests: Array<{ url: string; key: string | null }> = [];
    await expect(syncExternalOcxCatalog({
      readConfig: () => config(),
      adminToken: () => `ocx_admin_${"b".repeat(43)}`,
      fetchImpl: (async (input, init) => {
        requests.push({
          url: String(input),
          key: new Headers(init?.headers).get("x-opencodex-api-key"),
        });
        return Response.json({ status: "ok", service: "something-else" });
      }) as typeof fetch,
    })).rejects.toThrow("did not identify as opencodex");
    expect(requests).toEqual([
      { url: "http://127.0.0.1:10100/healthz", key: null },
    ]);
  });
});
