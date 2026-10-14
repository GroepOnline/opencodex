import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshCodexModelCatalog } from "../src/codex/refresh";
import { syncModelsToCodex } from "../src/codex/sync";
import type { OcxConfig } from "../src/types";

const config = { port: 10100, defaultProvider: "openai", providers: {} } as OcxConfig;
const homes: string[] = [];
const saved = { codex: process.env.CODEX_HOME, ocx: process.env.OPENCODEX_HOME };

function testHome() {
  const base = mkdtempSync(join(tmpdir(), "ocx-idempotence-"));
  homes.push(base);
  const codexHome = join(base, "codex");
  const ocxHome = join(base, "ocx");
  mkdirSync(codexHome);
  mkdirSync(ocxHome);
  process.env.CODEX_HOME = codexHome;
  process.env.OPENCODEX_HOME = ocxHome;
  const catalogPath = join(codexHome, "opencodex-catalog.json");
  const cachePath = join(codexHome, "models_cache.json");
  const configPath = join(codexHome, "config.toml");
  const settings = 'model = "gpt-5.6-sol"\nmodel_catalog_json = "opencodex-catalog.json"\n';
  writeFileSync(configPath, settings);
  writeFileSync(catalogPath, JSON.stringify({
    models: [{
      slug: "gpt-5.6-sol",
      display_name: "gpt-5.6-sol",
      description: "native baseline",
      priority: 9,
      visibility: "list",
      base_instructions: "You are Codex, a coding agent based on GPT-5.",
      supported_reasoning_levels: [{ effort: "medium", description: "m" }],
    }],
  }, null, 2) + "\n");
  return { base, codexHome, catalogPath, cachePath, configPath, settings };
}

function snapshot(path: string) {
  return {
    sha: createHash("sha256").update(readFileSync(path)).digest("hex"),
    mtimeMs: statSync(path).mtimeMs,
  };
}

afterEach(() => {
  if (saved.codex === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = saved.codex;
  if (saved.ocx === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = saved.ocx;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("built-in Codex catalog idempotence (#360)", () => {
  test("second sync keeps catalog, cache, native selection and session history unchanged", async () => {
    const home = testHome();
    const session = join(home.codexHome, "sessions", "history.jsonl");
    mkdirSync(join(home.codexHome, "sessions"));
    writeFileSync(session, '{"native":"history"}\n');
    const first = await refreshCodexModelCatalog(config, undefined, { catalogPath: home.catalogPath });
    expect(first.catalogWritten).toBe(true);
    expect(existsSync(home.cachePath)).toBe(true);
    const catalog = snapshot(home.catalogPath);
    const cache = snapshot(home.cachePath);
    const history = snapshot(session);

    const second = await refreshCodexModelCatalog(config, undefined, { catalogPath: home.catalogPath });
    expect(second.catalogExists).toBe(true);
    expect(second.catalogWritten).toBe(false);
    expect(second.cacheSynced).toBe(false);
    expect(second.added).toBe(0);
    expect(snapshot(home.catalogPath)).toEqual(catalog);
    expect(snapshot(home.cachePath)).toEqual(cache);
    expect(snapshot(session)).toEqual(history);
    expect(readFileSync(home.configPath, "utf8")).toBe(home.settings);
    expect(JSON.parse(readFileSync(home.catalogPath, "utf8")).models.some((m: { slug?: string }) => m.slug === "gpt-5.6-sol")).toBe(true);
  });

  test("matching fresh cache remains untouched; corrupted and drifted caches get repaired", async () => {
    const home = testHome();
    await refreshCodexModelCatalog(config, undefined, { catalogPath: home.catalogPath });
    const original = JSON.parse(readFileSync(home.cachePath, "utf8"));
    const fresh = JSON.stringify({ fetched_at: "2026-10-14T00:00:00Z", client_version: "99.99.99", models: original.models }, null, 2) + "\n";
    writeFileSync(home.cachePath, fresh);
    const valid = snapshot(home.cachePath);
    const unchanged = await refreshCodexModelCatalog(config, undefined, { catalogPath: home.catalogPath });
    expect(unchanged.catalogWritten).toBe(false);
    expect(unchanged.cacheSynced).toBe(false);
    expect(snapshot(home.cachePath)).toEqual(valid);

    writeFileSync(home.cachePath, "{broken", "utf8");
    const repaired = await refreshCodexModelCatalog(config, undefined, { catalogPath: home.catalogPath });
    expect(repaired.catalogWritten).toBe(false);
    expect(repaired.cacheSynced).toBe(true);
    expect(JSON.parse(readFileSync(home.cachePath, "utf8")).models).toEqual(JSON.parse(readFileSync(home.catalogPath, "utf8")).models);

    writeFileSync(home.cachePath, JSON.stringify({ fetched_at: "2026-10-14T00:00:00Z", client_version: "99.99.99", models: [] }));
    const drifted = await refreshCodexModelCatalog(config, undefined, { catalogPath: home.catalogPath });
    expect(drifted.catalogWritten).toBe(false);
    expect(drifted.cacheSynced).toBe(true);
    const final = snapshot(home.cachePath);
    const stable = await refreshCodexModelCatalog(config, undefined, { catalogPath: home.catalogPath });
    expect(stable.cacheSynced).toBe(false);
    expect(snapshot(home.cachePath)).toEqual(final);
  });

  test("validated no-op managed catalog stays injected without false warning; unmanaged catalog remains blocked", async () => {
    const home = testHome();
    let injectedPath: string | null | undefined = "unset";
    const logs: string[] = [];
    const warnings: string[] = [];
    const injectCodexConfig = async (_port: number, _config: OcxConfig, opts: { catalogPath?: string | null }) => {
      injectedPath = opts.catalogPath;
      return { success: true, message: "injected" };
    };
    const noOp = await syncModelsToCodex(10100, config, { log: s => logs.push(String(s)), error: s => warnings.push(String(s)) }, {
      refreshCodexModelCatalog: async () => ({
        added: 0, path: home.catalogPath, catalogExists: true,
        catalogWritten: false, cacheSynced: false, catalogValidated: true,
        comboOmissions: [],
      }),
      injectCodexConfig,
      currentExternalCodexModelProvider: () => null,
      currentUserOwnedRootOpenaiBaseUrl: () => false,
      collectCodexHomeDiagnostic: () => ({
        applicable: false, mismatch: false, effectiveCodexHome: home.codexHome,
        appCodexHome: home.codexHome, orcaCodexHome: null, warning: null, action: null,
      }),
    });
    expect(noOp.ok).toBe(true);
    expect(noOp.catalogWritten).toBe(false);
    expect(noOp.cacheSynced).toBe(false);
    expect(noOp.warning).toBeUndefined();
    expect(injectedPath).toBe(home.catalogPath);
    expect(logs.some(s => s.includes("models appended"))).toBe(false);
    expect(warnings).toEqual([]);

    const unmanaged = await syncModelsToCodex(10100, config, null, {
      refreshCodexModelCatalog: async () => ({
        added: 0, path: home.catalogPath, catalogExists: true,
        catalogWritten: false, cacheSynced: false, comboOmissions: [],
      }),
      injectCodexConfig,
      currentExternalCodexModelProvider: () => null,
      currentUserOwnedRootOpenaiBaseUrl: () => false,
    });
    expect(unmanaged.warning).toContain("did not materialize");
    expect(injectedPath).toBeNull();
  });
});
