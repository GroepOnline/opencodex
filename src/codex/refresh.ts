import { existsSync, readFileSync } from "node:fs";
import { invalidateCodexModelsCache, syncCatalogModels } from "./catalog";
import type { ComboCatalogOmission } from "./catalog/aggregation";
import { CODEX_MODELS_CACHE_PATH } from "./paths";
import { atomicWriteFile } from "../config";
import type { OcxConfig } from "../types";

export interface CodexCatalogRefreshResult {
  added: number;
  path: string;
  catalogExists: boolean;
  catalogWritten: boolean;
  /** Set only by a successful built-in managed sync, including no-op byte matches. */
  catalogValidated?: boolean;
  cacheSynced: boolean;
  comboOmissions: ComboCatalogOmission[];
}

interface RefreshDeps {
  syncCatalogModels: typeof syncCatalogModels;
  invalidateCodexModelsCache: typeof invalidateCodexModelsCache;
  existsSync: typeof existsSync;
}

const defaultDeps: RefreshDeps = {
  syncCatalogModels,
  invalidateCodexModelsCache,
  existsSync,
};

export interface CodexCatalogRefreshOptions {
  /** Managed lifecycle callers pass the canonical OCX catalog path explicitly. */
  catalogPath?: string;
}

export function syncCodexModelsCacheFromCatalog(catalogPath: string): void {
  const content = readFileSync(catalogPath, "utf8");
  atomicWriteFile(CODEX_MODELS_CACHE_PATH, content);
}

/**
 * Rebuild/validate the managed Codex catalog, then check for cache drift.
 * The invalidator preserves a valid cache and only writes its Codex wrapper
 * when missing, corrupt, or materially different from the catalog models.
 */
export async function refreshCodexModelCatalog(
  config: OcxConfig,
  deps: RefreshDeps = defaultDeps,
  options: CodexCatalogRefreshOptions = {},
): Promise<CodexCatalogRefreshResult> {
  const result = await deps.syncCatalogModels(config, options);
  const catalogExists = deps.existsSync(result.path);
  const catalogWritten = result.catalogWritten === true;
  const comboOmissions = result.comboOmissions ?? [];
  if (!catalogExists) {
    return { ...result, catalogExists, catalogWritten: false, cacheSynced: false, comboOmissions };
  }
  const cacheSynced = deps.invalidateCodexModelsCache(result.path);
  return { ...result, catalogExists, catalogWritten, cacheSynced, comboOmissions };
}
