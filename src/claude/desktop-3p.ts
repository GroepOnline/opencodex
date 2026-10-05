import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile, getConfigPath } from "../config";
import type { OcxClaudeDesktopProfile } from "../types";
import { claudeDesktopConfigLibraryDir, resolveConfigLibraryDir } from "./desktop-3p-paths";
import {
  parseDesktopProfile,
  reconcileDesktopProfile,
  renderDesktopProfile,
  type DesktopProfileModel,
} from "./desktop-profile";
import { nativeOpenAiContextWindow } from "../codex/catalog";
import { assertDesktop3pModelsValid } from "./desktop-3p-guard";

export interface Desktop3pModelEntry {
  name: string;
  labelOverride: string;
  anthropicFamilyTier: "opus" | "fable" | "sonnet" | "haiku";
  isFamilyDefault?: boolean;
  /**
   * Desktop's documented 1M-context capability assertion. Set ONLY from an
   * authoritative routed contextWindow >= 1M — never guessed (devlog 136 B5).
   */
  supports1m?: true;
  /** When true, Desktop selects the 1M variant by default (official schema, Luna research 260722). */
  prefer1m?: true;
}

/**
 * static (default, Pro-verified devlog 138): pinned inferenceModels with
 * modelDiscoveryEnabled:false — a static list OVERRIDES discovery (no merge), so
 * this is the deterministic shape. hybrid keeps discovery:true alongside the list
 * (claude-code-router's version-defensive pattern). discovery: /v1/models only.
 */
export type Desktop3pConfigMode = "hybrid" | "discovery" | "static";

export interface Desktop3pRoutedModel {
  provider: string;
  id: string;
  /** Authoritative context window (CatalogModel.contextWindow); optional. */
  contextWindow?: number;
}

/**
 * 1M-context eligibility, shared with the Desktop DTO so the dashboard's 1M chip can
 * never disagree with what the writer emits. The DTO imports this from here — keeping
 * the constant in this module avoids a cycle, since shared.ts already reads
 * claude/desktop-profile.
 */
export const DESKTOP_SUPPORTS_1M_THRESHOLD = 1_000_000;

export interface Desktop3pConfigLibraryOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
}

/**
 * Resolve the config library from the same user-data root Claude Desktop uses. Keeping this in one
 * helper prevents the writer and dashboard status probe from agreeing on a path Desktop never reads.
 *
 * The resolution itself lives in `./desktop-3p-paths`, which ports Claude Desktop's own `GE()`
 * branch for branch — including the `-3p` suffix the app appends to its userData root. Dropping
 * that suffix points us at a directory Desktop never reads (GitHub #539).
 */
export function resolveDesktop3pConfigLibraryPath(
  options: Desktop3pConfigLibraryOptions = {},
): string {
  if (options.env === undefined && options.platform === undefined && options.homeDir === undefined) {
    return claudeDesktopConfigLibraryDir();
  }
  return resolveConfigLibraryDir({
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
    home: options.homeDir ?? homedir(),
  });
}

/** Laptop tunnel target for Claude Desktop sync. The helper copies the applied 3P library here. */
export const LAPTOP_PROXY_GATEWAY = "http://127.0.0.1:10100";

const APPLIED_DESKTOP_3P_ID = /^[A-Za-z0-9_-]+$/;

export type AppliedDesktop3pLibrary =
  | {
      ok: true;
      appliedId: string;
      meta: Record<string, unknown>;
      config: unknown;
      fingerprint: string;
      laptopGateway: string;
    }
  | { ok: false; status: 404; error: string };

/**
 * Read the currently applied Claude Desktop 3P library so a laptop helper can
 * copy it through ocx-tunnel without SSH into the proxy host homedir.
 */
export function readAppliedDesktop3pLibrary(
  options: Desktop3pConfigLibraryOptions = {},
): AppliedDesktop3pLibrary {
  const libraryPath = resolveDesktop3pConfigLibraryPath(options);
  const metaPath = join(libraryPath, "_meta.json");
  if (!existsSync(metaPath)) {
    return { ok: false, status: 404, error: "Claude Desktop 3P library not applied yet" };
  }
  let meta: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(metaPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, status: 404, error: "Claude Desktop 3P library has no appliedId" };
    }
    meta = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, status: 404, error: "Claude Desktop 3P library has no appliedId" };
  }
  const appliedId = typeof meta.appliedId === "string" ? meta.appliedId : null;
  if (!appliedId || !APPLIED_DESKTOP_3P_ID.test(appliedId)) {
    return { ok: false, status: 404, error: "Claude Desktop 3P library has no appliedId" };
  }
  const entries = Array.isArray(meta.entries) ? meta.entries : [];
  const opencodexEntry = entries.find(
    (entry): entry is Record<string, unknown> =>
      !!entry && typeof entry === "object" && !Array.isArray(entry) && entry.name === "opencodex",
  );
  const registryId = opencodexEntry && typeof opencodexEntry.id === "string" ? opencodexEntry.id : null;
  if (!registryId || !APPLIED_DESKTOP_3P_ID.test(registryId) || appliedId !== registryId) {
    return { ok: false, status: 404, error: "Claude Desktop 3P config missing" };
  }
  const configPath = join(libraryPath, `${registryId}.json`);
  let raw: string;
  let config: unknown;
  try {
    raw = readFileSync(configPath, "utf8");
    config = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, status: 404, error: "Claude Desktop 3P config missing" };
  }
  // Do not log `config`: the 3P JSON can contain inferenceGatewayApiKey.
  return {
    ok: true,
    appliedId,
    meta,
    config,
    fingerprint: createHash("sha256").update(raw).digest("hex").slice(0, 16),
    laptopGateway: LAPTOP_PROXY_GATEWAY,
  };
}

/** CLI arg parsing for `ocx claude desktop` mode flags (mutually exclusive). */
export function parseDesktop3pModeArgs(flags: string[]): { mode: Desktop3pConfigMode } | { error: string } {
  const known = new Map<string, Desktop3pConfigMode>([
    ["--static", "static"],
    ["--hybrid", "hybrid"],
    ["--discovery-only", "discovery"],
  ]);
  const unknown = flags.filter(a => !known.has(a));
  if (unknown.length > 0) return { error: `알 수 없는 옵션: ${unknown.join(" ")} (지원: --static, --hybrid, --discovery-only)` };
  const picked = [...new Set(flags.map(a => known.get(a)!))];
  if (picked.length > 1) return { error: "모드 옵션은 하나만 쓸 수 있습니다 (--static | --hybrid | --discovery-only)." };
  return { mode: picked[0] ?? "static" };
}

interface Desktop3pMetadataEntry {
  id: string;
  name: string;
  [key: string]: unknown;
}

interface Desktop3pMetadata {
  appliedId?: string;
  entries: Desktop3pMetadataEntry[];
  [key: string]: unknown;
}

interface Desktop3pRegistrySnapshot {
  registry: Map<string, string>;
  aliasesByRoute: Map<string, string>;
  sourceSignature?: string;
}

let desktop3pSnapshot: Desktop3pRegistrySnapshot = {
  registry: new Map(),
  aliasesByRoute: new Map(),
};
// Discovery/generation cannot replace the last validated on-disk assignments.
let appliedDesktop3pSnapshot: Desktop3pRegistrySnapshot | undefined;

const DESKTOP_REGISTRY_MAX_JSON_BYTES = 1024 * 1024;
const DESKTOP_REGISTRY_MAX_META_BYTES = 64 * 1024;
const DESKTOP_REGISTRY_MAX_MODELS = 2000;
let desktop3pMetaCache: { path: string; signature: string; appliedId: string } | undefined;

function desktopRegistryFileSignature(path: string, maxBytes: number): string {
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile() || stat.size > BigInt(maxBytes)) throw new Error("Invalid Desktop registry source");
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

/** Read at most the byte bound, from a stable regular-file descriptor (never a FIFO). */
function readDesktopRegistryJson(path: string, signature: string, maxBytes: number): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(maxBytes) ||
        [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":") !== signature) {
      throw new Error("Desktop registry source changed");
    }
    const buffer = Buffer.alloc(Number(stat.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length !== Number(stat.size) || desktopRegistryFileSignature(path, maxBytes) !== signature) {
      throw new Error("Desktop registry source changed");
    }
    return JSON.parse(buffer.subarray(0, length).toString("utf8").replace(/^﻿/, "")) as unknown;
  } finally {
    closeSync(fd);
  }
}

function isDesktopRegistryObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Observe only persisted Desktop assignments and the applied static library. No discovery,
 * config reload, or process lifecycle change: malformed or racing sources keep the last good map.
 */
export function refreshDesktop3pRegistry(): boolean {
  try {
    const profilePath = getConfigPath();
    const metaPath = join(resolveDesktop3pConfigLibraryPath(), "_meta.json");
    const profileSignature = desktopRegistryFileSignature(profilePath, DESKTOP_REGISTRY_MAX_JSON_BYTES);
    const metaSignature = desktopRegistryFileSignature(metaPath, DESKTOP_REGISTRY_MAX_META_BYTES);
    let appliedId: string;
    if (desktop3pMetaCache?.path === metaPath && desktop3pMetaCache.signature === metaSignature) {
      appliedId = desktop3pMetaCache.appliedId;
    } else {
      const meta = readDesktopRegistryJson(metaPath, metaSignature, DESKTOP_REGISTRY_MAX_META_BYTES);
      if (!isDesktopRegistryObject(meta) || typeof meta.appliedId !== "string" ||
          !APPLIED_DESKTOP_3P_ID.test(meta.appliedId) || meta.appliedId.length > 128 ||
          !Array.isArray(meta.entries) || meta.entries.length > DESKTOP_REGISTRY_MAX_MODELS ||
          !meta.entries.some(entry => isDesktopRegistryObject(entry) &&
            entry.name === "opencodex" && entry.id === meta.appliedId)) return false;
      appliedId = meta.appliedId;
      desktop3pMetaCache = { path: metaPath, signature: metaSignature, appliedId };
    }
    const activePath = join(resolveDesktop3pConfigLibraryPath(), `${appliedId}.json`);
    const activeSignature = desktopRegistryFileSignature(activePath, DESKTOP_REGISTRY_MAX_JSON_BYTES);
    const sourceSignature = JSON.stringify([profilePath, profileSignature, metaPath, metaSignature, appliedId, activeSignature]);
    if (appliedDesktop3pSnapshot?.sourceSignature === sourceSignature) return false;

    const persisted = readDesktopRegistryJson(profilePath, profileSignature, DESKTOP_REGISTRY_MAX_JSON_BYTES);
    if (!isDesktopRegistryObject(persisted) || !isDesktopRegistryObject(persisted.claudeCode)) return false;
    const rawProfile = persisted.claudeCode.desktopProfile;
    if (!isDesktopRegistryObject(rawProfile) || !isDesktopRegistryObject(rawProfile.assignments) ||
        Object.keys(rawProfile.assignments).length > DESKTOP_REGISTRY_MAX_MODELS) return false;
    const profile = parseDesktopProfile(rawProfile);
    const active = readDesktopRegistryJson(activePath, activeSignature, DESKTOP_REGISTRY_MAX_JSON_BYTES);
    if (!isDesktopRegistryObject(active) || !Array.isArray(active.inferenceModels) ||
        active.inferenceModels.length > DESKTOP_REGISTRY_MAX_MODELS) return false;
    const activeAliases = new Set<string>();
    for (const model of active.inferenceModels) {
      if (!isDesktopRegistryObject(model) || typeof model.name !== "string" ||
          model.name.length > 200 || !/^claude-[a-z0-9-]+$/.test(model.name) ||
          activeAliases.has(model.name)) return false;
      activeAliases.add(model.name);
    }
    const registry = new Map<string, string>();
    const aliasesByRoute = new Map<string, string>();
    for (const [route, assignment] of Object.entries(profile.assignments)) {
      if (!activeAliases.delete(assignment.alias)) continue;
      aliasesByRoute.set(route, assignment.alias);
      // Real Anthropic ids must remain identity-resolved for native passthrough.
      if (!route.startsWith("anthropic/claude-")) registry.set(assignment.alias, route);
    }
    // An unknown active alias signals an incomplete profile/library pair; never guess its route.
    if (activeAliases.size > 0) return false;
    registerLegacyDesktop3pAliases(registry, aliasesByRoute.keys(), false);
    if (desktopRegistryFileSignature(profilePath, DESKTOP_REGISTRY_MAX_JSON_BYTES) !== profileSignature ||
        desktopRegistryFileSignature(metaPath, DESKTOP_REGISTRY_MAX_META_BYTES) !== metaSignature ||
        desktopRegistryFileSignature(activePath, DESKTOP_REGISTRY_MAX_JSON_BYTES) !== activeSignature) return false;
    appliedDesktop3pSnapshot = { registry, aliasesByRoute, sourceSignature };
    return true;
  } catch {
    // Optional integration: never log source JSON (it can contain credentials).
    return false;
  }
}

/** Derive a stable letter-first, three-character base36 code from a route key. */
export function deriveDesktop3pCode(route: string): string {
  const hash = createHash("sha256").update(route).digest();
  const n = hash.readUInt32BE(0) % 33696;
  const first = String.fromCharCode(97 + Math.floor(n / 1296));
  const rest = (n % 1296).toString(36).padStart(2, "0");
  return first + rest;
}

/**
 * Alias for one proxy model. Real Anthropic models pass through unchanged (they must
 * keep hitting the sk-ant native passthrough); everything else gets a Claude-shaped
 * `claude-opus-4-8-{code}` id. Opus 4.8 is chosen deliberately: Desktop's effort
 * selector is an allowlist keyed on exact supported model ids (Opus 4.8/4.7/4.6,
 * Sonnet 4.6 — devlog 131), and 4.6+ canonical ids are dateless, so the letter-first
 * 3-char suffix can never collide with a real id or a legacy date suffix.
 */
export function desktop3pAlias(provider: string, modelId: string): string {
  if (provider === "anthropic" && modelId.startsWith("claude-")) return modelId;
  return `claude-opus-4-8-${deriveDesktop3pCode(`${provider}/${modelId}`)}`;
}

/** Pre-rename alias shape (claude-opus-4-{code}) — still decoded for stale Desktop configs. */
export function legacyDesktop3pAlias(provider: string, modelId: string): string {
  return `claude-opus-4-${deriveDesktop3pCode(`${provider}/${modelId}`)}`;
}

function registerLegacyDesktop3pAliases(
  registry: Map<string, string>, routes: Iterable<string>, warnOnCollision = true,
): void {
  // Stable route order keeps compatibility hashes independent of picker/default ordering.
  for (const route of [...routes].sort((a, b) => a.localeCompare(b))) {
    if (route.startsWith("anthropic/claude-")) continue;
    const providerEnd = route.indexOf("/");
    const legacy = legacyDesktop3pAlias(route.slice(0, providerEnd), route.slice(providerEnd + 1));
    const existing = registry.get(legacy);
    if (existing && existing !== route) {
      if (warnOnCollision) {
        console.warn(`[opencodex] Claude Desktop legacy alias collision: ${legacy} stays bound to ${existing}; ignoring ${route}`);
      }
      continue;
    }
    registry.set(legacy, route);
  }
}

/** Test seam: reset generated and applied state between isolated homes. */
export function resetDesktop3pRegistryForTests(): void {
  desktop3pSnapshot = { registry: new Map(), aliasesByRoute: new Map() };
  appliedDesktop3pSnapshot = undefined;
  desktop3pMetaCache = undefined;
}

function displayModelId(modelId: string): string {
  return modelId
    // Capability markers like [1m] are not name text: strip the brackets so the label
    // reads "K3 1M", never "K3[1m]".
    .replace(/\[([^\]]+)\]/g, "-$1")
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => {
      const lower = part.toLowerCase();
      if (lower === "gpt" || lower === "glm" || lower === "ai" || lower === "1m") return lower.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function collectDesktop3pModels(
  nativeSlugs: string[],
  routedModels: Array<Desktop3pRoutedModel>,
  profile?: OcxClaudeDesktopProfile,
): { models: Desktop3pModelEntry[] } & Desktop3pRegistrySnapshot {
  const registry = new Map<string, string>();
  const models: Desktop3pModelEntry[] = [];
  const candidates: Desktop3pRoutedModel[] = [
    // Native candidates carry their real context window from the same accessor the
    // Desktop DTO uses, so a native 1M/372k model resolves identically in the written
    // config and on the dashboard.
    ...nativeSlugs.map(id => {
      const contextWindow = nativeOpenAiContextWindow(id);
      return { provider: "native", id, ...(contextWindow !== undefined ? { contextWindow } : {}) };
    }),
    ...routedModels,
  ];

  if (profile) {
    const profileModels = candidates.map(({ provider, id, contextWindow }) => ({
      route: `${provider}/${id}`,
      label: `${displayModelId(id)} (${provider})`,
      ...(typeof contextWindow === "number" ? { contextWindow } : {}),
    } satisfies DesktopProfileModel));
    const reconciled = reconcileDesktopProfile(profile, profileModels);
    const rendered = renderDesktopProfile(reconciled, profileModels);
    const aliasesByRoute = new Map<string, string>();
    for (const model of rendered) {
      aliasesByRoute.set(model.route, model.name);
      if (!model.route.startsWith("anthropic/claude-")) registry.set(model.name, model.route);
      models.push({
        name: model.name,
        labelOverride: model.label,
        anthropicFamilyTier: model.family,
        ...(model.isFamilyDefault ? { isFamilyDefault: true } : {}),
        ...(model.supports1m ? { supports1m: true, prefer1m: true } : {}),
      });
    }
    registerLegacyDesktop3pAliases(registry, aliasesByRoute.keys());
    return { models, registry, aliasesByRoute };
  }

  for (const { provider, id, contextWindow } of candidates) {
    const route = `${provider}/${id}`;
    const alias = desktop3pAlias(provider, id);
    const supports1m = typeof contextWindow === "number" && contextWindow >= DESKTOP_SUPPORTS_1M_THRESHOLD
      ? { supports1m: true as const }
      : {};
    if (alias === id) {
      // Real Anthropic model: keep it OUT of the decode registry — registering it would
      // make resolveInboundModel() non-identity and kill the sk-ant native passthrough
      // (audit 133 #1). It still appears in the static Desktop model list below.
      models.push({
        name: alias,
        labelOverride: `${displayModelId(id)} (${provider})`,
        anthropicFamilyTier: "opus",
        ...supports1m,
      ...(supports1m.supports1m ? { prefer1m: true as const } : {}),
      });
      continue;
    }
    const existingRoute = registry.get(alias);
    if (existingRoute !== undefined) {
      console.warn(`[opencodex] Claude Desktop 3P alias collision: ${alias} maps to both ${existingRoute} and ${route}; skipping ${route}`);
      continue;
    }

    registry.set(alias, route);
    // Back-compat decode for Desktop configs written before the opus-4-8 rename.
    const legacy = legacyDesktop3pAlias(provider, id);
    if (!registry.has(legacy)) registry.set(legacy, route);
    models.push({
      name: alias,
      labelOverride: `${displayModelId(id)} (${provider})`,
      anthropicFamilyTier: "opus",
      ...supports1m,
      ...(supports1m.supports1m ? { prefer1m: true as const } : {}),
    });
  }

  if (models[0]) models[0].isFamilyDefault = true;
  const aliasesByRoute = new Map(candidates.map(({ provider, id }) => [`${provider}/${id}`, desktop3pAlias(provider, id)]));
  return { models, registry, aliasesByRoute };
}

/** Build and install the registry used to decode Desktop aliases. */
export function buildDesktop3pRegistry(
  nativeSlugs: string[],
  routedModels: Array<Desktop3pRoutedModel>,
  profile?: OcxClaudeDesktopProfile,
): Map<string, string> {
  const { registry, aliasesByRoute } = collectDesktop3pModels(nativeSlugs, routedModels, profile);
  desktop3pSnapshot = { registry, aliasesByRoute };
  return registry;
}

/** Generate Claude Desktop 3P model entries from the proxy's available models. */
export function generateDesktop3pModels(
  nativeSlugs: string[],
  routedModels: Array<Desktop3pRoutedModel>,
  profile?: OcxClaudeDesktopProfile,
): Desktop3pModelEntry[] {
  const { models, registry, aliasesByRoute } = collectDesktop3pModels(nativeSlugs, routedModels, profile);
  desktop3pSnapshot = { registry, aliasesByRoute };
  return models;
}

/** Applied bindings take precedence; discovery can add aliases without rebinding applied ones. */
export function resolveDesktop3pAlias(alias: string): string | null {
  return appliedDesktop3pSnapshot?.registry.get(alias) ?? desktop3pSnapshot.registry.get(alias) ?? null;
}

/** Applied route aliases take precedence over generated discovery and legacy hashes. */
export function activeDesktop3pAlias(provider: string, modelId: string): string {
  const route = `${provider}/${modelId}`;
  const applied = appliedDesktop3pSnapshot?.aliasesByRoute.get(route);
  if (applied) return applied;
  const generated = desktop3pSnapshot.aliasesByRoute.get(route);
  if (generated) {
    const binding = appliedDesktop3pSnapshot?.registry.get(generated);
    if (!binding || binding === route) return generated;
    const legacy = legacyDesktop3pAlias(provider, modelId);
    if (resolveDesktop3pAlias(legacy) === route) return legacy;
    throw new Error("Desktop discovery alias conflicts with the applied profile");
  }
  return desktop3pAlias(provider, modelId);
}

/**
 * Generate the complete Claude Desktop 3P gateway config.
 *
 * Default mode is "static" (Pro-verified, devlog 138): the static list is the ONLY
 * channel for supports1m/tier pins and it overrides discovery anyway (no merge), so
 * discovery stays off for determinism. supports1m makes Desktop offer a separate 1M
 * row; selecting it sends the bare id + `anthropic-beta: context-1m-2025-08-07`.
 */
export function generateDesktop3pConfig(
  port: number,
  nativeSlugs: string[],
  routedModels: Array<Desktop3pRoutedModel>,
  apiKey = "ocx",
  mode: Desktop3pConfigMode = "static",
  profile?: OcxClaudeDesktopProfile,
): object {
  const base = {
    inferenceProvider: "gateway",
    inferenceCredentialKind: "static",
    inferenceGatewayBaseUrl: `http://127.0.0.1:${port}`,
    inferenceGatewayApiKey: apiKey,
  };
  if (mode === "discovery") {
    // Build/refresh the decode registry even though no static list is emitted.
    buildDesktop3pRegistry(nativeSlugs, routedModels, profile);
    return { ...base, modelDiscoveryEnabled: true };
  }
  return {
    ...base,
    modelDiscoveryEnabled: mode === "hybrid",
    inferenceModels: (() => {
      const models = generateDesktop3pModels(nativeSlugs, routedModels, profile);
      // Fail loud at the write boundary rather than ship a config Desktop rejects:
      // the output counterpart of the request-path guards.
      assertDesktop3pModelsValid(models);
      return models;
    })(),
  };
}

function parseMetadata(path: string): Desktop3pMetadata {
  if (!existsSync(path)) return { entries: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Desktop3pMetadata>;
  if (!Array.isArray(parsed.entries)) throw new Error("Claude Desktop 3P _meta.json has no entries array");
  return { ...parsed, entries: parsed.entries };
}

/** Write and apply the opencodex config in Claude Desktop 3P's config library. */
export function writeDesktop3pConfig(
  port: number,
  nativeSlugs: string[],
  routedModels: Array<Desktop3pRoutedModel>,
  apiKey?: string,
  mode: Desktop3pConfigMode = "static",
  profile?: OcxClaudeDesktopProfile,
): { written: boolean; path: string; reason?: string; fingerprint?: string } {
  const libraryPath = resolveDesktop3pConfigLibraryPath();
  const metadataPath = join(libraryPath, "_meta.json");
  let configPath = libraryPath;

  try {
    mkdirSync(libraryPath, { recursive: true, mode: 0o700 });
    const metadata = parseMetadata(metadataPath);
    const existing = metadata.entries.find(entry => entry?.name === "opencodex" && typeof entry.id === "string");
    const id = existing?.id ?? randomUUID();
    configPath = join(libraryPath, `${id}.json`);
    const entry: Desktop3pMetadataEntry = existing ? { ...existing, id, name: "opencodex" } : { id, name: "opencodex" };
    const entries = existing
      ? metadata.entries.map(current => current === existing ? entry : current)
      : [...metadata.entries, entry];

    const configJson = JSON.stringify(generateDesktop3pConfig(port, nativeSlugs, routedModels, apiKey, mode, profile), null, 2) + "\n";
    const fingerprint = createHash("sha256").update(configJson).digest("hex").slice(0, 16);
    const { backupPath } = atomicReplaceDesktopConfig(configPath, configJson);
    try {
      atomicWriteFile(metadataPath, JSON.stringify({ ...metadata, appliedId: id, entries }, null, 2) + "\n");
    } catch (metaError) {
      // Rollback: restore the backed-up config if metadata write fails.
      if (backupPath && existsSync(backupPath)) copyFileSync(backupPath, configPath);
      throw metaError;
    }
    return { written: true, path: configPath, fingerprint };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { written: false, path: configPath, reason };
  }
}

/** Backup an existing owned config then atomically replace it. Exported for failure-path tests. */
export function atomicReplaceDesktopConfig(
  path: string,
  content: string,
  writer: (path: string, content: string) => void = atomicWriteFile,
): { backupPath?: string } {
  const backupPath = `${path}.bak`;
  if (existsSync(path)) copyFileSync(path, backupPath);
  writer(path, content);
  return existsSync(backupPath) ? { backupPath } : {};
}
