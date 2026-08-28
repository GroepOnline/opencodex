import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { atomicWriteFile, getConfigDir } from "../../config";
import { buildModelsRequest, resolveModelsAuthToken } from "../../oauth";
import type { OcxConfig, OcxProviderConfig } from "../../types";
import { modelInList } from "../../types";
import { getProviderRegistryEntry } from "../../providers/registry";
import { CODEX_GPT5_IDENTITY_LINE } from "../../adapters/identity";
import { filterCursorConfiguredModelsByLiveDiscovery } from "../../adapters/cursor/discovery";
import { fetchCursorUsableModels } from "../../adapters/cursor/live-models";
import {
  COMBO_NAMESPACE,
  comboModelId,
  getCombo,
  listComboIds,
  targetKey,
} from "../../combos";
import type { NormalizedComboConfig } from "../../combos/types";
import { providerDestinationResolvedError } from "../../lib/destination-policy";
import { redactSecretString } from "../../lib/redact";
import upstreamModelsSnapshot from "../data/upstream-models.json";

import {
  activeCodexModelsCachePath,
  catalogBackupPathFor,
  findNativeTemplate,
  isDefaultCatalogPath,
  legacyCatalogBackupPath,
  parseCatalogJson,
  readCatalog,
  readCatalogBackup,
  readCodexCatalogPath,
} from "./parsing";
import type { RawCatalog, RawEntry } from "./parsing";
import {
  codexExecInvocation,
  isSpawnableCodexCandidate,
} from "../exec-invocation";
import {
  loadPersistedCodexRuntime,
  resolveAndPersistCodexRuntime,
} from "../runtime";
import type { EffortClampDiagnostic } from "../runtime";

export {
  isSpawnableCodexCandidate,
  codexExecInvocation,
} from "../exec-invocation";

export const BUNDLED_CATALOG_CACHE_MS = 60_000;
const RESOLVED_RUNTIME_MEMO_MS = 15_000;

export let bundledCatalogCache: {
  /** Selected runtime identity; must change when doctor/sync picks a different binary. */
  key: string;
  expiresAt: number;
  value: RawCatalog | null;
} | null = null;

/** Memoized runtime resolution so cache-hit checks don't re-probe binaries (~350ms under load). */
let resolvedRuntimeMemo: {
  fingerprint: string;
  command: string;
  version: string;
  expiresAt: number;
} | null = null;

/** Cheap persisted-selection read so doctor-style upgrades (same env, new binary) bust the memo. */
function persistedSelectionStamp(deps: BundledCatalogDeps): string {
  try {
    const persisted = loadPersistedCodexRuntime({
      configDir: deps.configDir,
      readFileSync: deps.readFileSync,
    });
    return persisted
      ? `${persisted.command}|${persisted.selectedVersion ?? ""}`
      : "";
  } catch {
    return "";
  }
}

/** Test-only: clear the bundled-catalog cache (owned here; sync.ts calls this instead of assigning the import). */
export function resetBundledCatalogCacheForTests(): void {
  bundledCatalogCache = null;
  resolvedRuntimeMemo = null;
}

/** Drop the process-local bundled catalog memo (e.g. after runtime selection changes). */
export function invalidateBundledCatalogCache(): void {
  bundledCatalogCache = null;
  resolvedRuntimeMemo = null;
}

export type ExecFile = (
  file: string,
  args: string[],
  options: {
    encoding: "utf8";
    stdio: ["ignore", "pipe", "ignore"];
    timeout: number;
    windowsHide: boolean;
    shell?: boolean;
    windowsVerbatimArguments?: boolean;
  },
) => string;

export interface BundledCatalogDeps {
  commandCandidates?: () => string[];
  execFileSync?: ExecFile;
  onEffortClamp?: (diagnostic: EffortClampDiagnostic) => void;
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, encoding: "utf8") => string;
  now?: () => number;
  discoverAlternatives?: boolean;
  fallbackCommand?: string;
}

export function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function codexCommandCandidates(): string[] {
  const envPath = process.env.CODEX_CLI_PATH?.trim();
  const candidates = envPath ? [envPath] : [];
  candidates.push(...codexShimCommandCandidates());
  if (process.platform === "win32") {
    for (const dir of (process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)) {
      candidates.push(join(dir, "codex.exe"), join(dir, "codex.cmd"));
    }
  }
  candidates.push("codex");
  return unique(candidates);
}

export function codexShimCommandCandidates(): string[] {
  try {
    const state = JSON.parse(
      readFileSync(join(getConfigDir(), "codex-shim.json"), "utf8"),
    ) as {
      wrapperPath?: unknown;
      originalPath?: unknown;
      backupPath?: unknown;
      wrappers?: Array<{
        wrapperPath?: unknown;
        originalPath?: unknown;
        backupPath?: unknown;
      }>;
    };
    const files =
      Array.isArray(state.wrappers) && state.wrappers.length > 0
        ? state.wrappers
        : [state];
    const out: string[] = [];
    for (const file of files) {
      for (const value of [
        file.backupPath,
        file.originalPath,
        file.wrapperPath,
      ]) {
        if (typeof value !== "string" || value.length === 0) continue;
        if (!isSpawnableCodexCandidate(value)) continue;
        out.push(value);
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function runCodexDebugModels(
  command: string,
  execFile: ExecFile,
  deps: Pick<BundledCatalogDeps, "env" | "platform" | "existsSync"> = {},
): string {
  const args = ["debug", "models", "--bundled"];
  const invocation = codexExecInvocation(
    command,
    args,
    deps.platform ?? process.platform,
    {
      env: deps.env,
      exists: deps.existsSync,
    },
  );
  return execFile(invocation.file, invocation.args, {
    encoding: "utf8" as const,
    stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"],
    timeout: 10_000,
    windowsHide: true,
    ...invocation.options,
  });
}

export function loadBundledCodexCatalog(
  deps: BundledCatalogDeps = {},
): RawCatalog | null {
  // `now` is a clock. Treating it as a cache bypass forced tests to patch
  // global Date.now and flake the full suite under shared isolates.
  const useCache =
    !deps.commandCandidates &&
    !deps.execFileSync &&
    !deps.existsSync &&
    !deps.readFileSync &&
    deps.discoverAlternatives === undefined;
  const nowMs = (deps.now ?? Date.now)();
  const execFile = deps.execFileSync ?? (execFileSync as unknown as ExecFile);
  const runtimeEnv = deps.env ?? process.env;
  const runtimePlatform = deps.platform ?? process.platform;
  const runtimeConfigDir = deps.configDir ?? getConfigDir();
  // Prefer the single resolved runtime so sync/clamp never probe a different binary
  // than OpenCodex will launch. Tests may inject commandCandidates to stub probing.
  let cacheKey: string | null = null;
  // resolveAndPersistCodexRuntime probes binaries (spawning codex --version etc.) on every
  // call, which made even bundled-catalog cache HITS cost ~350ms under load. Memoize the
  // resolved identity per environment fingerprint. The memo is deliberately shorter than
  // the catalog cache so in-place upgrades are periodically re-probed; environment/runtime
  // selection changes produce a new fingerprint immediately.
  const envParts = [
    runtimeEnv.OPENCODEX_HOME ?? "",
    runtimeEnv.CODEX_CLI_PATH ?? "",
    runtimeEnv.PATH ?? "",
    runtimePlatform,
    runtimeConfigDir,
  ];
  const envFingerprint = useCache
    ? [...envParts, persistedSelectionStamp(deps)].join("\0")
    : null;
  const candidates =
    deps.commandCandidates?.() ??
    (() => {
      let runtimeCommand: string;
      let runtimeVersion = "";
      if (
        useCache &&
        resolvedRuntimeMemo &&
        resolvedRuntimeMemo.fingerprint === envFingerprint &&
        resolvedRuntimeMemo.expiresAt > nowMs
      ) {
        runtimeCommand = resolvedRuntimeMemo.command;
        runtimeVersion = resolvedRuntimeMemo.version;
      } else {
        const resolved = resolveAndPersistCodexRuntime({
          execFileSync: execFile,
          configDir: deps.configDir,
          env: deps.env,
          platform: deps.platform,
          existsSync: deps.existsSync,
          readFileSync: deps.readFileSync,
          now: deps.now,
          discoverAlternatives: deps.discoverAlternatives,
          fallbackCommand: deps.fallbackCommand,
        });
        runtimeCommand = resolved.runtime.command;
        runtimeVersion = resolved.runtime.version ?? "";
        if (useCache && resolved.runtime.source !== "fallback") {
          // Re-read the persisted stamp AFTER resolution: persistCodexRuntime may have just
          // (re)written it, and a stale pre-call stamp would force one redundant re-probe.
          // Keep this memo shorter than the catalog TTL so in-place binary upgrades self-heal,
          // and never memoize an ephemeral fallback after a transient probe failure.
          const postStamp = persistedSelectionStamp(deps);
          resolvedRuntimeMemo = {
            fingerprint: [...envParts, postStamp].join("\0"),
            command: runtimeCommand,
            version: runtimeVersion,
            expiresAt: nowMs + RESOLVED_RUNTIME_MEMO_MS,
          };
        } else if (useCache) {
          resolvedRuntimeMemo = null;
        }
      }
      if (useCache) {
        cacheKey = [
          runtimeCommand,
          runtimeVersion,
          runtimeEnv.OPENCODEX_HOME ?? "",
          runtimeEnv.CODEX_CLI_PATH ?? "",
        ].join("\0");
      }
      return [runtimeCommand];
    })();
  if (
    useCache &&
    cacheKey &&
    bundledCatalogCache &&
    bundledCatalogCache.key === cacheKey &&
    bundledCatalogCache.expiresAt > nowMs
  ) {
    return bundledCatalogCache.value;
  }
  for (const command of unique(candidates)) {
    try {
      const catalog = parseCatalogJson(
        runCodexDebugModels(command, execFile, deps),
      );
      if (catalog && findNativeTemplate(catalog)) {
        if (useCache && cacheKey) {
          bundledCatalogCache = {
            key: cacheKey,
            expiresAt: nowMs + BUNDLED_CATALOG_CACHE_MS,
            value: catalog,
          };
        }
        return catalog;
      }
    } catch {
      /* try next candidate */
    }
  }
  if (useCache && cacheKey) {
    bundledCatalogCache = {
      key: cacheKey,
      expiresAt: nowMs + BUNDLED_CATALOG_CACHE_MS,
      value: null,
    };
  }
  return null;
}

export function materializeBundledCodexCatalog(
  path: string,
  deps: BundledCatalogDeps = {},
): RawCatalog | null {
  const catalog = loadBundledCodexCatalog(deps);
  if (!catalog) return null;
  try {
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFile(path, JSON.stringify(catalog, null, 2) + "\n");
  } catch {
    return null;
  }
  return catalog;
}

export function loadCatalogForSync(path: string): RawCatalog | null {
  const bundled = isDefaultCatalogPath(path) ? loadBundledCodexCatalog() : null;
  if (bundled) return JSON.parse(JSON.stringify(bundled)) as RawCatalog;
  const catalog = readCatalog(path);
  if (catalog && findNativeTemplate(catalog)) return catalog;
  return (
    readCatalog(catalogBackupPathFor(path)) ??
    (isDefaultCatalogPath(path)
      ? readCatalog(legacyCatalogBackupPath())
      : null) ??
    readCatalog(activeCodexModelsCachePath()) ??
    materializeBundledCodexCatalog(path) ??
    catalog
  );
}

export function readCurrentCatalogOrCache(): RawCatalog | null {
  const path = readCodexCatalogPath();
  return (
    (isDefaultCatalogPath(path) ? loadBundledCodexCatalog() : null) ??
    readCatalog(path) ??
    readCatalog(activeCodexModelsCachePath())
  );
}

export function loadCatalogTemplate(): RawEntry | null {
  const catalogPath = readCodexCatalogPath();
  const native =
    findNativeTemplate(readCatalog(catalogPath)) ??
    findNativeTemplate(readCatalogBackup(catalogPath)) ??
    findNativeTemplate(readCatalog(activeCodexModelsCachePath())) ??
    findNativeTemplate(loadBundledCodexCatalog());
  return native ? JSON.parse(JSON.stringify(native)) : null;
}
