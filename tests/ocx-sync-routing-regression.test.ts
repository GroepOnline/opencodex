import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncExternalOcxCatalog } from "../src/codex/external-ocx-catalog";
import { syncModelsToCodex } from "../src/codex/sync";
import type { OcxConfig } from "../src/types";

test("ocx sync recognizes verified external OCX routing without a false warning or no-op cache restart", async () => {
  const logs: string[] = [];
  const config = { port: 10100, defaultProvider: "openai", providers: {} } as OcxConfig;
  const result = await syncModelsToCodex(
    10100,
    config,
    { log: line => logs.push(String(line)), error: line => logs.push(String(line)) },
    {
      refreshCodexModelCatalog: async () => { throw new Error("should not refresh native catalog"); },
      currentExternalCodexModelProvider: () => "ocx",
      injectCodexConfig: async () => ({
        success: true,
        message: '⚠️ Codex routing NOT injected: external model_provider "ocx"',
      }),
      syncExternalOcxCatalog: async () => ({
        handled: true,
        models: 635,
        catalogPath: "/tmp/ocx-test/opencodex-catalog.json",
        catalogWritten: false,
        cacheSynced: false,
      }),
      collectCodexHomeDiagnostic: () => ({
        applicable: false,
        mismatch: false,
        effectiveCodexHome: "/tmp/ocx-test",
        appCodexHome: "/tmp/ocx-test",
        orcaCodexHome: null,
        warning: null,
        action: null,
      }),
    },
  );
  expect(result.ok).toBe(true);
  expect(result.catalogWritten).toBe(false);
  expect(result.message).toContain("OCX");
  expect(result.message).not.toContain("NOT injected");
  expect(logs.join("\n")).not.toContain("NOT injected");
});

test("ocx sync is idempotent and repairs cache drift without rewriting unchanged catalogs", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-sync-noop-"));
  try {
    const catalogPath = join(root, "opencodex-catalog.json");
    const cachePath = join(root, "models_cache.json");
    const configText = [
      'model_provider = "ocx"',
      '[model_providers.ocx]',
      'base_url = "http://127.0.0.1:10100/v1"',
    ].join("\n");
    let catalogWrites = 0;
    let cacheWrites = 0;
    const deps = {
      readConfig: () => configText,
      catalogPath,
      cachePath,
      loadCatalog: () => ({
        models: [{
          slug: "gpt-5.6-sol",
          display_name: "GPT-5.6-Sol",
          base_instructions: "You are Codex.",
          supported_reasoning_levels: [{ effort: "medium", description: "medium" }],
        }],
      }),
      adminToken: () => "test-credential-not-sent-to-unknown-service",
      writeConfig: () => {},
      writeCatalog: (path: string, content: string) => {
        catalogWrites++;
        writeFileSync(path, content);
      },
      invalidateCache: () => {
        cacheWrites++;
        const models = JSON.parse(readFileSync(catalogPath, "utf8")).models;
        writeFileSync(cachePath, JSON.stringify({ fetched_at: "2000-01-01T00:00:00Z", client_version: "0.0.0", models }));
        return true;
      },
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/healthz")) return Response.json({ status: "ok", service: "opencodex" });
        if (url.endsWith("/api/subagent-models")) return Response.json({ chosen: [] });
        return Response.json([
          { provider: "openai", id: "gpt-5.6-sol", native: true, disabled: false },
          { provider: "combo", id: "factory", namespaced: "combo/factory", disabled: false },
        ]);
      }) as typeof fetch,
    };

    const first = await syncExternalOcxCatalog(deps);
    const second = await syncExternalOcxCatalog(deps);
    expect(first.catalogWritten).toBe(true);
    expect(first.cacheSynced).toBe(true);
    expect(second.catalogWritten).toBe(false);
    expect(second.cacheSynced).toBe(false);
    expect(catalogWrites).toBe(1);
    expect(cacheWrites).toBe(1);

    writeFileSync(cachePath, JSON.stringify({ models: [] }));
    const repaired = await syncExternalOcxCatalog(deps);
    expect(repaired.catalogWritten).toBe(false);
    expect(repaired.cacheSynced).toBe(true);
    expect(catalogWrites).toBe(1);
    expect(cacheWrites).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
