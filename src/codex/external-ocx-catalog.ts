import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../config";
import { configuredAdminToken } from "../lib/admin-secrets";
import { isLoopbackHostname } from "../server/auth-cors";
import { providerTableString, rootTomlString } from "./injected-marker";
import { setRootModelCatalogPath } from "./inject";
import { CODEX_CONFIG_PATH, DEFAULT_CATALOG_PATH } from "./paths";
import {
  buildCatalogEntries,
  catalogModelSlug,
  invalidateCodexModelsCache,
  type CatalogModel,
} from "./catalog";
import { loadCatalogForSync } from "./catalog/bundled";
import { findNativeTemplate } from "./catalog/parsing";

type RemoteModelRow = CatalogModel & {
  namespaced?: string;
  disabled?: boolean;
  native?: boolean;
};

export type ExternalOcxCatalogSyncResult = {
  handled: boolean;
  catalogPath: string | null;
  models: number;
  cacheSynced: boolean;
};
export interface ExternalOcxCatalogDeps {
  fetchImpl?: typeof fetch;
  readConfig?: () => string;
  adminToken?: () => string | null;
  loadCatalog?: typeof loadCatalogForSync;
  invalidateCache?: typeof invalidateCodexModelsCache;
  writeConfig?: (content: string) => void;
  catalogPath?: string;
  writeCatalog?: (path: string, content: string) => void;
}

/** Only classify a user-owned external provider as OCX when it targets loopback /v1. */
export function externalOcxManagementOrigin(content: string): string | null {
  const provider = rootTomlString(content, "model_provider");
  if (!provider || provider === "openai" || provider === "opencodex") return null;
  const raw = providerTableString(content, provider, "base_url");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !isLoopbackHostname(url.hostname)) return null;
    if (url.pathname.replace(/\/+$/, "") !== "/v1") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function remoteCatalogModel(row: RemoteModelRow): CatalogModel {
  return {
    id: row.id,
    provider: row.provider,
    ...(row.provider === "combo" && row.namespaced && row.namespaced !== `combo/${row.id}`
      ? { alias: row.namespaced }
      : {}),
    ...(row.displayName ? { displayName: row.displayName } : {}),
    ...(row.owned_by ? { owned_by: row.owned_by } : {}),
    ...(row.reasoningEfforts ? { reasoningEfforts: row.reasoningEfforts } : {}),
    ...(row.defaultReasoningEffort ? { defaultReasoningEffort: row.defaultReasoningEffort } : {}),
    ...(row.contextWindow ? { contextWindow: row.contextWindow } : {}),
    ...(row.maxInputTokens ? { maxInputTokens: row.maxInputTokens } : {}),
    ...(row.maxOutputTokens ? { maxOutputTokens: row.maxOutputTokens } : {}),
    ...(row.contextCap ? { contextCap: row.contextCap } : {}),
    ...(row.contextCapped ? { contextCapped: true } : {}),
    ...(row.inputModalities ? { inputModalities: row.inputModalities } : {}),
    ...(row.parallelToolCalls !== undefined ? { parallelToolCalls: row.parallelToolCalls } : {}),
    ...(row.capabilities ? { capabilities: row.capabilities } : {}),
  };
}
async function jsonOrThrow<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  try {
    return await response.json() as T;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

/** Mirror central OCX's client-visible model state into an isolated Codex home. */
export async function syncExternalOcxCatalog(
  deps: ExternalOcxCatalogDeps = {},
): Promise<ExternalOcxCatalogSyncResult> {
  if (!existsSync(CODEX_CONFIG_PATH) && !deps.readConfig) {
    return { handled: false, catalogPath: null, models: 0, cacheSynced: false };
  }
  const content = (deps.readConfig ?? (() => readFileSync(CODEX_CONFIG_PATH, "utf8")))();
  const origin = externalOcxManagementOrigin(content);
  if (!origin) return { handled: false, catalogPath: null, models: 0, cacheSynced: false };

  const fetchImpl = deps.fetchImpl ?? fetch;
  const health = await jsonOrThrow<{ status?: unknown; service?: unknown }>(
    await fetchImpl(`${origin}/healthz`, { signal: AbortSignal.timeout(3000) }),
    "OCX health probe",
  );
  if (health.status !== "ok" || health.service !== "opencodex") {
    throw new Error("loopback endpoint did not identify as opencodex");
  }

  const token = (deps.adminToken ?? configuredAdminToken)();
  if (!token) throw new Error("OCX admin credential unavailable for remote catalog sync");
  const headers = new Headers({ "X-OpenCodex-API-Key": token });
  const [rows, subagents] = await Promise.all([
    jsonOrThrow<RemoteModelRow[]>(
      await fetchImpl(`${origin}/api/models`, { headers, signal: AbortSignal.timeout(10_000) }),
      "OCX model catalog",
    ),
    jsonOrThrow<{ chosen?: unknown }>(
      await fetchImpl(`${origin}/api/subagent-models`, { headers, signal: AbortSignal.timeout(10_000) }),
      "OCX subagent catalog",
    ),
  ]);
  if (!Array.isArray(rows)) throw new Error("OCX model catalog has an invalid shape");
  const active = rows.filter(row =>
    row && row.disabled === false && typeof row.id === "string" && typeof row.provider === "string"
  );
  if (active.length === 0) throw new Error("OCX model catalog contains no active models");

  const catalogPath = deps.catalogPath ?? DEFAULT_CATALOG_PATH;
  const base = (deps.loadCatalog ?? loadCatalogForSync)(catalogPath);
  const template = findNativeTemplate(base);
  if (!base || !template) throw new Error("Codex bundled catalog template is unavailable");

  const native = active.filter(row => row.native === true).map(row => row.id);
  const routed = active.filter(row => row.native !== true).map(remoteCatalogModel);
  const featured = Array.isArray(subagents.chosen)
    ? subagents.chosen.filter((value): value is string => typeof value === "string").slice(0, 5)
    : [];
  const exactCombos = new Set(
    routed.filter(model => model.provider === "combo").map(catalogModelSlug),
  );
  const models = buildCatalogEntries(
    template,
    native,
    routed,
    featured,
    false,
    "default",
    exactCombos,
  );
  if (models.length === 0) throw new Error("OCX catalog conversion produced no Codex models");

  const catalogContent = JSON.stringify({ ...base, models }, null, 2) + "\n";
  (deps.writeCatalog ?? atomicWriteFile)(catalogPath, catalogContent);
  const cacheSynced = (deps.invalidateCache ?? invalidateCodexModelsCache)();
  if (!cacheSynced) throw new Error("Codex models cache could not be synchronized");

  const nextConfig = setRootModelCatalogPath(content, catalogPath);
  if (nextConfig !== content) {
    (deps.writeConfig ?? ((value: string) => atomicWriteFile(CODEX_CONFIG_PATH, value)))(nextConfig);
  }
  return {
    handled: true,
    catalogPath,
    models: models.length,
    cacheSynced,
  };
}
