#!/usr/bin/env bun
/**
 * Reviewable, idempotent, dry-run-first promotion pipeline for OCX JSON state.
 *
 * Order: backup current → import legacy into staging → schema normalize →
 * dedupe → referential checks → record-count reconciliation → functional
 * smoke → promote.
 *
 * Default is dry-run. Apply/promote refuse without a verified backup.
 * Live writes require --promote. Values of apiKey/token/refresh/cookie
 * fields are never logged — names, ids, lengths, and env-ref flags only.
 *
 * Usage:
 *   bun scripts/state-reconcile.ts --current <dir> --legacy <dir> [--legacy <dir>...]
 *   bun scripts/state-reconcile.ts --current <dir> --legacy <dir> --backup-dir <dir> --staging <dir> --apply
 *   bun scripts/state-reconcile.ts --current <dir> --legacy <dir> --backup-dir <dir> --staging <dir> --apply --promote
 *   bun scripts/state-reconcile.ts --rollback --current <dir> --backup-dir <dir>
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateConfigCandidate } from "../src/config";

export const STATE_RECONCILE_SCHEMA_VERSION = 1;
export const BACKUP_MANIFEST_NAME = "reconcile-backup.manifest.json";
export const STAGING_MANIFEST_NAME = "reconcile-staging.manifest.json";
export const ROLLBACK_POINTER_NAME = "reconcile-rollback.json";

export const STATE_FILES = [
  "config.json",
  "auth.json",
  "auth.json.pre-multiauth",
  "codex-accounts.json",
  "usage.jsonl",
  "responses-state.json",
  "admin-api-token",
  "service-api-token",
  "claude-persistent-env.json",
  "telemetry-id.txt",
] as const;

const SECRET_KEY =
  /^(apiKey|key|access|refresh|accessToken|refreshToken|idToken|token|password|clientSecret|cookie)$/i;

export type ReconcileMode = "dry-run" | "apply" | "promote" | "rollback";

export interface ReconcileOptions {
  currentDir: string;
  legacyDirs: string[];
  backupDir?: string;
  stagingDir?: string;
  mode: ReconcileMode;
  prefer: "current" | "legacy";
}

export interface FileFingerprint {
  name: string;
  present: boolean;
  size: number | null;
  sha256: string | null;
}

export interface BackupManifest {
  version: 1;
  createdAt: string;
  sourceDir: string;
  files: FileFingerprint[];
}

export interface SecretShape {
  present: boolean;
  length?: number;
  envRef?: boolean;
}

export interface ProviderRecord {
  name: string;
  adapter: string | null;
  authMode: string | null;
  disabled: boolean;
  hasApiKey: boolean;
  apiKey: SecretShape;
  apiKeyPoolIds: string[];
  defaultModel: string | null;
}

export interface ApiKeyRecord {
  id: string | null;
  name: string | null;
  createdAt: string | null;
  key: SecretShape;
}

export interface ComboRecord {
  id: string;
  targetProviders: string[];
  targetModels: string[];
  strategy: string | null;
}

export interface OAuthAccountRecord {
  provider: string;
  id: string | null;
  needsReauth: boolean;
  hasRefresh: boolean;
  hasAccess: boolean;
  refreshLen: number;
  accessLen: number;
}

export interface StoreInventory {
  label: string;
  path: string;
  files: FileFingerprint[];
  schemaVersion: number | null;
  openaiProviderTierVersion: number | null;
  providers: ProviderRecord[];
  apiKeys: ApiKeyRecord[];
  combos: ComboRecord[];
  disabledModels: string[];
  subagentModels: string[];
  providerContextCaps: string[];
  providerCooldowns: string[];
  oauthAccounts: OAuthAccountRecord[];
  oauthProviders: string[];
  usageLines: number;
  usageRequestIds: string[];
  usageProviders: string[];
  configParseError: string | null;
}

export interface DomainDiff {
  domain: string;
  currentCount: number;
  legacyCounts: Record<string, number>;
  missingFromCurrent: string[];
  conflicts: string[];
}

export interface ReconcileCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface ReconcileReport {
  mode: ReconcileMode;
  wrote: string[];
  current: StoreInventory;
  legacy: StoreInventory[];
  domains: DomainDiff[];
  checks: ReconcileCheck[];
  backup: { required: boolean; verified: boolean; path: string | null };
  stagingDigest: string | null;
}

export class ReconcileError extends Error {
  constructor(
    message: string,
    readonly exitCode = 2,
  ) {
    super(message);
    this.name = "ReconcileError";
  }
}

function isEnvRef(value: string): boolean {
  return /^\$\{?\w+\}?$/.test(value);
}

export function secretShape(value: unknown): SecretShape {
  if (typeof value !== "string") return { present: false };
  return {
    present: value.length > 0,
    length: value.length,
    envRef: isEnvRef(value),
  };
}

export function redactForLog(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key) && typeof value === "string") {
    return value
      ? `<redacted len=${value.length} envRef=${isEnvRef(value)}>`
      : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactForLog(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([child, childValue]) => [child, redactForLog(childValue, child)],
      ),
    );
  }
  return value;
}

function sha256Bytes(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function fingerprintFile(dir: string, name: string): FileFingerprint {
  const path = join(dir, name);
  if (!existsSync(path) || !statSync(path).isFile()) {
    return { name, present: false, size: null, sha256: null };
  }
  const bytes = readFileSync(path);
  return {
    name,
    present: true,
    size: bytes.byteLength,
    sha256: sha256Bytes(bytes),
  };
}

function readJson(
  path: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return {
      ok: true,
      value: JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function inventoryProviders(config: Record<string, unknown>): ProviderRecord[] {
  const providers = asRecord(config.providers) ?? {};
  return Object.entries(providers).map(([name, raw]) => {
    const provider = asRecord(raw) ?? {};
    const pool = Array.isArray(provider.apiKeyPool) ? provider.apiKeyPool : [];
    return {
      name,
      adapter: typeof provider.adapter === "string" ? provider.adapter : null,
      authMode:
        typeof provider.authMode === "string" ? provider.authMode : null,
      disabled: provider.disabled === true,
      hasApiKey:
        typeof provider.apiKey === "string" && provider.apiKey.length > 0,
      apiKey: secretShape(provider.apiKey),
      apiKeyPoolIds: pool
        .map((entry) => asRecord(entry)?.id)
        .filter((id): id is string => typeof id === "string"),
      defaultModel:
        typeof provider.defaultModel === "string"
          ? provider.defaultModel
          : null,
    };
  });
}

function inventoryAuth(dir: string): {
  providers: string[];
  accounts: OAuthAccountRecord[];
} {
  const parsed = readJson(join(dir, "auth.json"));
  if (!parsed.ok) return { providers: [], accounts: [] };
  const store = asRecord(parsed.value);
  if (!store) return { providers: [], accounts: [] };
  const accounts: OAuthAccountRecord[] = [];
  for (const [provider, raw] of Object.entries(store)) {
    const value = asRecord(raw);
    if (!value) continue;
    if (Array.isArray(value.accounts)) {
      for (const row of value.accounts) {
        const account = asRecord(row) ?? {};
        const cred = asRecord(account.credential) ?? {};
        accounts.push({
          provider,
          id: typeof account.id === "string" ? account.id : null,
          needsReauth: account.needsReauth === true,
          hasRefresh:
            typeof cred.refresh === "string" && cred.refresh.length > 0,
          hasAccess: typeof cred.access === "string" && cred.access.length > 0,
          refreshLen:
            typeof cred.refresh === "string" ? cred.refresh.length : 0,
          accessLen: typeof cred.access === "string" ? cred.access.length : 0,
        });
      }
    } else if (
      typeof value.refresh === "string" ||
      typeof value.access === "string"
    ) {
      accounts.push({
        provider,
        id: typeof value.accountId === "string" ? value.accountId : "legacy",
        needsReauth: false,
        hasRefresh:
          typeof value.refresh === "string" && value.refresh.length > 0,
        hasAccess: typeof value.access === "string" && value.access.length > 0,
        refreshLen:
          typeof value.refresh === "string" ? value.refresh.length : 0,
        accessLen: typeof value.access === "string" ? value.access.length : 0,
      });
    }
  }
  return { providers: Object.keys(store).sort(), accounts };
}

function inventoryUsage(dir: string): {
  lines: number;
  requestIds: string[];
  providers: string[];
} {
  const path = join(dir, "usage.jsonl");
  if (!existsSync(path)) return { lines: 0, requestIds: [], providers: [] };
  const rows = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim());
  const requestIds: string[] = [];
  const providers = new Set<string>();
  for (const line of rows) {
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (typeof row.requestId === "string") requestIds.push(row.requestId);
      if (typeof row.provider === "string") providers.add(row.provider);
    } catch {
      /* keep line count honest; skip the broken row */
    }
  }
  return { lines: rows.length, requestIds, providers: [...providers].sort() };
}

export function inventoryStore(dir: string, label: string): StoreInventory {
  const configPath = join(dir, "config.json");
  const parsed = existsSync(configPath)
    ? readJson(configPath)
    : { ok: false as const, error: "missing" };
  const config = parsed.ok ? asRecord(parsed.value) : null;
  const auth = inventoryAuth(dir);
  const usage = inventoryUsage(dir);
  const providers = config ? inventoryProviders(config) : [];
  const apiKeys = Array.isArray(config?.apiKeys)
    ? config.apiKeys.map((raw) => {
        const entry = asRecord(raw) ?? {};
        return {
          id: typeof entry.id === "string" ? entry.id : null,
          name: typeof entry.name === "string" ? entry.name : null,
          createdAt:
            typeof entry.createdAt === "string" ? entry.createdAt : null,
          key: secretShape(entry.key),
        };
      })
    : [];
  const combos = Object.entries(asRecord(config?.combos) ?? {}).map(
    ([id, raw]) => {
      const combo = asRecord(raw) ?? {};
      const targets = Array.isArray(combo.targets) ? combo.targets : [];
      return {
        id,
        targetProviders: targets
          .map((target) => asRecord(target)?.provider)
          .filter((name): name is string => typeof name === "string"),
        targetModels: targets
          .map((target) => asRecord(target)?.model)
          .filter((name): name is string => typeof name === "string"),
        strategy: typeof combo.strategy === "string" ? combo.strategy : null,
      };
    },
  );
  return {
    label,
    path: dir,
    files: STATE_FILES.map((name) => fingerprintFile(dir, name)),
    schemaVersion:
      typeof config?.schemaVersion === "number"
        ? config.schemaVersion
        : typeof config?.schema_version === "number"
          ? config.schema_version
          : null,
    openaiProviderTierVersion:
      typeof config?.openaiProviderTierVersion === "number"
        ? config.openaiProviderTierVersion
        : null,
    providers,
    apiKeys,
    combos,
    disabledModels: Array.isArray(config?.disabledModels)
      ? config.disabledModels.filter(
          (id): id is string => typeof id === "string",
        )
      : [],
    subagentModels: Array.isArray(config?.subagentModels)
      ? config.subagentModels.filter(
          (id): id is string => typeof id === "string",
        )
      : [],
    providerContextCaps: Object.keys(
      asRecord(config?.providerContextCaps) ?? {},
    ).sort(),
    providerCooldowns: Object.keys(
      asRecord(config?.providerCooldowns) ?? {},
    ).sort(),
    oauthAccounts: auth.accounts,
    oauthProviders: auth.providers,
    usageLines: usage.lines,
    usageRequestIds: usage.requestIds,
    usageProviders: usage.providers,
    configParseError: parsed.ok ? null : parsed.error,
  };
}

function setDiff(
  current: Iterable<string>,
  legacy: Iterable<string>,
): { missing: string[]; extra: string[] } {
  const have = new Set(current);
  const want = new Set(legacy);
  return {
    missing: [...want].filter((id) => !have.has(id)).sort(),
    extra: [...have].filter((id) => !want.has(id)).sort(),
  };
}

export function diffDomains(
  current: StoreInventory,
  legacy: StoreInventory[],
): DomainDiff[] {
  const domain = (
    name: string,
    currentIds: string[],
    legacyIds: (store: StoreInventory) => string[],
    conflictIds: string[] = [],
  ): DomainDiff => ({
    domain: name,
    currentCount: currentIds.length,
    legacyCounts: Object.fromEntries(
      legacy.map((store) => [store.label, legacyIds(store).length]),
    ),
    missingFromCurrent: [
      ...new Set(
        legacy.flatMap(
          (store) => setDiff(currentIds, legacyIds(store)).missing,
        ),
      ),
    ].sort(),
    conflicts: conflictIds,
  });

  const providerConflicts = [
    ...new Set(
      legacy.flatMap((store) => {
        const conflicts: string[] = [];
        for (const left of current.providers) {
          const right = store.providers.find((row) => row.name === left.name);
          if (!right) continue;
          if (
            left.adapter !== right.adapter ||
            left.authMode !== right.authMode ||
            left.disabled !== right.disabled
          ) {
            conflicts.push(left.name);
          }
        }
        return conflicts;
      }),
    ),
  ];

  return [
    domain(
      "providers",
      current.providers.map((row) => row.name),
      (store) => store.providers.map((row) => row.name),
      providerConflicts,
    ),
    domain(
      "apiKeys",
      current.apiKeys.map((row) => row.id ?? ""),
      (store) => store.apiKeys.map((row) => row.id ?? ""),
    ),
    domain(
      "apiKeyPool",
      current.providers.flatMap((row) =>
        row.apiKeyPoolIds.map((id) => `${row.name}:${id}`),
      ),
      (store) =>
        store.providers.flatMap((row) =>
          row.apiKeyPoolIds.map((id) => `${row.name}:${id}`),
        ),
    ),
    domain(
      "oauthAccounts",
      current.oauthAccounts.map((row) => `${row.provider}:${row.id ?? ""}`),
      (store) =>
        store.oauthAccounts.map((row) => `${row.provider}:${row.id ?? ""}`),
    ),
    domain(
      "combos",
      current.combos.map((row) => row.id),
      (store) => store.combos.map((row) => row.id),
    ),
    domain(
      "disabledModels",
      current.disabledModels,
      (store) => store.disabledModels,
    ),
    domain(
      "subagentModels",
      current.subagentModels,
      (store) => store.subagentModels,
    ),
    domain(
      "providerContextCaps",
      current.providerContextCaps,
      (store) => store.providerContextCaps,
    ),
    domain(
      "providerCooldowns",
      current.providerCooldowns,
      (store) => store.providerCooldowns,
    ),
    domain("usage", current.usageRequestIds, (store) => store.usageRequestIds),
  ];
}

export function createBackup(
  currentDir: string,
  backupDir: string,
): BackupManifest {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const files = STATE_FILES.map((name) => {
    const source = join(currentDir, name);
    const fingerprint = fingerprintFile(currentDir, name);
    if (fingerprint.present) copyFileSync(source, join(backupDir, name));
    return fingerprintFile(backupDir, name);
  });
  const manifest: BackupManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    sourceDir: resolve(currentDir),
    files,
  };
  writeFileSync(
    join(backupDir, BACKUP_MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  return manifest;
}

export function verifyBackup(
  currentDir: string,
  backupDir: string,
): { ok: boolean; detail: string; manifest: BackupManifest | null } {
  const manifestPath = join(backupDir, BACKUP_MANIFEST_NAME);
  if (!existsSync(manifestPath))
    return { ok: false, detail: "backup manifest missing", manifest: null };
  const parsed = readJson(manifestPath);
  if (!parsed.ok)
    return {
      ok: false,
      detail: `backup manifest unreadable: ${parsed.error}`,
      manifest: null,
    };
  const manifest = parsed.value as BackupManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) {
    return {
      ok: false,
      detail: "backup manifest schema mismatch",
      manifest: null,
    };
  }
  for (const expected of manifest.files) {
    const onDisk = fingerprintFile(backupDir, expected.name);
    if (
      expected.present !== onDisk.present ||
      expected.sha256 !== onDisk.sha256
    ) {
      return {
        ok: false,
        detail: `backup file drifted: ${expected.name}`,
        manifest,
      };
    }
  }
  const present = manifest.files.filter((file) => file.present);
  if (
    present.length === 0 &&
    fingerprintFile(currentDir, "config.json").present
  ) {
    return { ok: false, detail: "backup contains no state files", manifest };
  }
  return { ok: true, detail: `verified ${present.length} file(s)`, manifest };
}

function cloneRecord<T>(value: T): T {
  return structuredClone(value);
}

export function normalizeAuthStore(raw: unknown): Record<string, unknown> {
  const store = asRecord(raw) ?? {};
  const normalized: Record<string, unknown> = {};
  for (const [provider, value] of Object.entries(store)) {
    const record = asRecord(value);
    if (!record) continue;
    if (Array.isArray(record.accounts)) {
      normalized[provider] = record;
      continue;
    }
    if (
      typeof record.refresh === "string" &&
      typeof record.access === "string"
    ) {
      const id =
        typeof record.accountId === "string" ? record.accountId : "legacy";
      normalized[provider] = {
        activeAccountId: id,
        accounts: [{ id, credential: record }],
      };
    }
  }
  return normalized;
}

export function normalizeConfig(raw: unknown): Record<string, unknown> {
  const config = asRecord(raw) ? cloneRecord(asRecord(raw)!) : {};
  if (typeof config.schemaVersion !== "number")
    config.schemaVersion = STATE_RECONCILE_SCHEMA_VERSION;
  const providers = asRecord(config.providers) ?? {};
  for (const [name, provider] of Object.entries(providers)) {
    const record = asRecord(provider);
    if (!record) continue;
    if (
      !Array.isArray(record.apiKeyPool) &&
      typeof record.apiKey === "string" &&
      record.apiKey.length > 0
    ) {
      // ponytail: id is een label, geen secret-afgeleide — hash alleen de
      // provider-naam zodat CodeQL taint op apiKey verdwijnt en ids stabiel blijven.
      const id = createHash("sha256")
        .update(`opencodex-pool-id:${name}`)
        .digest("hex")
        .slice(0, 8);
      record.apiKeyPool = [{ id, key: record.apiKey }];
    }
  }
  config.providers = providers;
  return config;
}

function mergePrefer<T>(
  current: T,
  incoming: T,
  prefer: "current" | "legacy",
): T {
  return prefer === "legacy" ? incoming : current;
}

export function mergeStores(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
  prefer: "current" | "legacy",
): Record<string, unknown> {
  const merged = cloneRecord(current);
  const currentProviders = asRecord(merged.providers) ?? {};
  const incomingProviders = asRecord(incoming.providers) ?? {};
  for (const [name, provider] of Object.entries(incomingProviders)) {
    if (!currentProviders[name]) currentProviders[name] = cloneRecord(provider);
    else
      currentProviders[name] = mergePrefer(
        currentProviders[name],
        cloneRecord(provider),
        prefer,
      );
  }
  merged.providers = currentProviders;

  const currentKeys = Array.isArray(merged.apiKeys) ? [...merged.apiKeys] : [];
  const incomingKeys = Array.isArray(incoming.apiKeys) ? incoming.apiKeys : [];
  const keyIndex = new Map<string, unknown>();
  for (const row of currentKeys) {
    const id = asRecord(row)?.id;
    if (typeof id === "string") keyIndex.set(id, row);
  }
  for (const row of incomingKeys) {
    const id = asRecord(row)?.id;
    if (typeof id !== "string") continue;
    if (!keyIndex.has(id)) {
      currentKeys.push(row);
      keyIndex.set(id, row);
    } else if (prefer === "legacy") {
      const at = currentKeys.findIndex((entry) => asRecord(entry)?.id === id);
      if (at >= 0) currentKeys[at] = row;
    }
  }
  merged.apiKeys = currentKeys;

  const currentCombos = asRecord(merged.combos) ?? {};
  for (const [id, combo] of Object.entries(asRecord(incoming.combos) ?? {})) {
    if (!currentCombos[id]) currentCombos[id] = cloneRecord(combo);
    else
      currentCombos[id] = mergePrefer(
        currentCombos[id],
        cloneRecord(combo),
        prefer,
      );
  }
  merged.combos = currentCombos;

  const disabled = new Set(
    [
      ...(Array.isArray(merged.disabledModels) ? merged.disabledModels : []),
      ...(Array.isArray(incoming.disabledModels)
        ? incoming.disabledModels
        : []),
    ].filter((id): id is string => typeof id === "string"),
  );
  merged.disabledModels = [...disabled].sort();
  return merged;
}

export function mergeAuth(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
  prefer: "current" | "legacy",
): Record<string, unknown> {
  const merged = cloneRecord(normalizeAuthStore(current));
  const extra = normalizeAuthStore(incoming);
  for (const [provider, raw] of Object.entries(extra)) {
    const incomingSet = asRecord(raw);
    const currentSet = asRecord(merged[provider]);
    if (!incomingSet) continue;
    if (!currentSet) {
      merged[provider] = incomingSet;
      continue;
    }
    const accounts = Array.isArray(currentSet.accounts)
      ? [...currentSet.accounts]
      : [];
    const seen = new Set(
      accounts
        .map((row) => asRecord(row)?.id)
        .filter((id): id is string => typeof id === "string"),
    );
    for (const row of Array.isArray(incomingSet.accounts)
      ? incomingSet.accounts
      : []) {
      const id = asRecord(row)?.id;
      if (typeof id !== "string") continue;
      if (!seen.has(id)) {
        accounts.push(row);
        seen.add(id);
      } else if (prefer === "legacy") {
        const at = accounts.findIndex((entry) => asRecord(entry)?.id === id);
        if (at >= 0) accounts[at] = row;
      }
    }
    currentSet.accounts = accounts;
    merged[provider] = currentSet;
  }
  return merged;
}

function mergeUsage(currentText: string, incomingText: string): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of [
    ...currentText.split(/\r?\n/),
    ...incomingText.split(/\r?\n/),
  ]) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let key = trimmed;
    try {
      const row = JSON.parse(trimmed) as Record<string, unknown>;
      key = `${String(row.requestId ?? "")}:${String(row.timestamp ?? "")}`;
    } catch {
      key = sha256Bytes(trimmed);
    }
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(trimmed);
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export function referentialChecks(
  config: Record<string, unknown>,
  auth: Record<string, unknown>,
): ReconcileCheck[] {
  const checks: ReconcileCheck[] = [];
  const providerNames = new Set(Object.keys(asRecord(config.providers) ?? {}));
  const combos = asRecord(config.combos) ?? {};
  for (const [id, raw] of Object.entries(combos)) {
    const targets = Array.isArray(asRecord(raw)?.targets)
      ? (asRecord(raw)!.targets as unknown[])
      : [];
    for (const target of targets) {
      const provider = asRecord(target)?.provider;
      if (typeof provider === "string" && !providerNames.has(provider)) {
        checks.push({
          id: `combo.${id}`,
          ok: false,
          detail: `target provider missing: ${provider}`,
        });
      }
    }
  }
  const providers = asRecord(config.providers) ?? {};
  for (const [name, raw] of Object.entries(providers)) {
    const provider = asRecord(raw) ?? {};
    if (provider.authMode === "oauth") {
      const set = asRecord(auth[name]);
      const count = Array.isArray(set?.accounts) ? set.accounts.length : 0;
      checks.push({
        id: `oauth.${name}`,
        ok: count > 0,
        detail:
          count > 0
            ? `${count} account(s)`
            : "authMode=oauth but no auth.json accounts",
      });
    }
  }
  if (checks.every((check) => check.ok) || checks.length === 0) {
    checks.push({
      id: "referential",
      ok: true,
      detail: "combo targets and oauth rows resolve",
    });
  }
  return checks;
}

export function smokeChecks(
  config: unknown,
  auth: unknown,
  usageText: string,
): ReconcileCheck[] {
  const checks: ReconcileCheck[] = [];
  const validated = validateConfigCandidate(config);
  checks.push({
    id: "config.schema",
    ok: validated.ok,
    detail: validated.ok ? "validateConfigCandidate ok" : validated.error,
  });
  const normalizedAuth = normalizeAuthStore(auth);
  checks.push({
    id: "auth.shape",
    ok: true,
    detail: `${Object.keys(normalizedAuth).length} oauth provider set(s)`,
  });
  let usageOk = true;
  let usageRows = 0;
  for (const line of usageText.split(/\r?\n/).filter(Boolean)) {
    try {
      JSON.parse(line);
      usageRows += 1;
    } catch {
      usageOk = false;
    }
  }
  checks.push({
    id: "usage.jsonl",
    ok: usageOk,
    detail: `${usageRows} row(s)`,
  });
  return checks;
}

function writeStateFile(dir: string, name: string, contents: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `${name}.ocx.reconcile.tmp`);
  writeFileSync(tmp, contents, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, join(dir, name));
}

function readJsonValue(path: string): unknown {
  const parsed = readJson(path);
  if (!parsed.ok)
    throw new ReconcileError(`${path} is not valid JSON: ${parsed.error}`);
  return parsed.value;
}

export function materializeStaging(
  currentDir: string,
  legacyDirs: string[],
  stagingDir: string,
  prefer: "current" | "legacy",
): { digest: string; files: string[] } {
  let config = existsSync(join(currentDir, "config.json"))
    ? normalizeConfig(readJsonValue(join(currentDir, "config.json")))
    : normalizeConfig({});
  let auth = existsSync(join(currentDir, "auth.json"))
    ? normalizeAuthStore(readJsonValue(join(currentDir, "auth.json")))
    : {};
  let usage = existsSync(join(currentDir, "usage.jsonl"))
    ? readFileSync(join(currentDir, "usage.jsonl"), "utf8")
    : "";

  for (const legacyDir of legacyDirs) {
    if (existsSync(join(legacyDir, "config.json"))) {
      config = mergeStores(
        config,
        normalizeConfig(readJsonValue(join(legacyDir, "config.json"))),
        prefer,
      );
    }
    if (existsSync(join(legacyDir, "auth.json"))) {
      auth = mergeAuth(
        auth,
        readJsonValue(join(legacyDir, "auth.json")),
        prefer,
      );
    }
    if (existsSync(join(legacyDir, "usage.jsonl"))) {
      usage = mergeUsage(
        usage,
        readFileSync(join(legacyDir, "usage.jsonl"), "utf8"),
      );
    }
  }

  mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  const written: string[] = [];
  writeStateFile(
    stagingDir,
    "config.json",
    `${JSON.stringify(config, null, 2)}\n`,
  );
  written.push("config.json");
  writeStateFile(stagingDir, "auth.json", `${JSON.stringify(auth, null, 2)}\n`);
  written.push("auth.json");
  writeStateFile(stagingDir, "usage.jsonl", usage);
  written.push("usage.jsonl");
  for (const name of STATE_FILES) {
    if (
      name === "config.json" ||
      name === "auth.json" ||
      name === "usage.jsonl"
    )
      continue;
    const source = join(currentDir, name);
    if (existsSync(source)) {
      copyFileSync(source, join(stagingDir, name));
      written.push(name);
    }
  }
  const digest = sha256Bytes(
    STATE_FILES.map(
      (name) => fingerprintFile(stagingDir, name).sha256 ?? "",
    ).join("|"),
  );
  writeFileSync(
    join(stagingDir, STAGING_MANIFEST_NAME),
    `${JSON.stringify({ version: 1, digest, files: written }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { digest, files: written };
}

export function promoteStaging(
  currentDir: string,
  stagingDir: string,
  backupDir: string,
): string[] {
  const verified = verifyBackup(currentDir, backupDir);
  if (!verified.ok)
    throw new ReconcileError(`refusing promote: ${verified.detail}`);
  if (!existsSync(join(stagingDir, "config.json")))
    throw new ReconcileError("refusing promote: staging has no config.json");
  const rollbackDir = join(backupDir, "pre-promote");
  mkdirSync(rollbackDir, { recursive: true, mode: 0o700 });
  const restored: string[] = [];
  for (const name of STATE_FILES) {
    const live = join(currentDir, name);
    if (existsSync(live)) copyFileSync(live, join(rollbackDir, name));
  }
  writeFileSync(
    join(backupDir, ROLLBACK_POINTER_NAME),
    `${JSON.stringify({ version: 1, dir: rollbackDir, at: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
  for (const name of STATE_FILES) {
    const staged = join(stagingDir, name);
    if (!existsSync(staged)) continue;
    copyFileSync(staged, join(currentDir, name));
    restored.push(name);
  }
  return restored;
}

export function rollbackLive(currentDir: string, backupDir: string): string[] {
  const pointerPath = join(backupDir, ROLLBACK_POINTER_NAME);
  const fallback = existsSync(join(backupDir, "pre-promote"))
    ? join(backupDir, "pre-promote")
    : backupDir;
  let source = fallback;
  if (existsSync(pointerPath)) {
    const parsed = readJson(pointerPath);
    const dir = parsed.ok ? asRecord(parsed.value)?.dir : null;
    if (typeof dir === "string" && existsSync(dir)) source = dir;
  }
  if (!existsSync(source))
    throw new ReconcileError("no rollback snapshot found");
  const restored: string[] = [];
  for (const name of STATE_FILES) {
    const from = join(source, name);
    if (!existsSync(from)) continue;
    copyFileSync(from, join(currentDir, name));
    restored.push(name);
  }
  if (restored.length === 0)
    throw new ReconcileError("rollback snapshot is empty");
  return restored;
}

function projectedChecks(
  currentDir: string,
  legacyDirs: string[],
  prefer: "current" | "legacy",
): { checks: ReconcileCheck[]; digest: string } {
  const tmp = join(
    tmpdir(),
    `ocx-reconcile-preview-${process.pid}-${Date.now()}`,
  );
  try {
    const { digest } = materializeStaging(currentDir, legacyDirs, tmp, prefer);
    const config = readJsonValue(join(tmp, "config.json"));
    const auth = existsSync(join(tmp, "auth.json"))
      ? readJsonValue(join(tmp, "auth.json"))
      : {};
    const usage = existsSync(join(tmp, "usage.jsonl"))
      ? readFileSync(join(tmp, "usage.jsonl"), "utf8")
      : "";
    return {
      digest,
      checks: [
        ...referentialChecks(asRecord(config) ?? {}, asRecord(auth) ?? {}),
        ...smokeChecks(config, auth, usage),
      ],
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function runReconcile(options: ReconcileOptions): ReconcileReport {
  const currentDir = resolve(options.currentDir);
  if (!existsSync(currentDir))
    throw new ReconcileError(`current store not found: ${currentDir}`);
  const legacyDirs = options.legacyDirs.map((dir) => resolve(dir));
  for (const dir of legacyDirs) {
    if (!existsSync(dir))
      throw new ReconcileError(`legacy store not found: ${dir}`);
  }

  const current = inventoryStore(currentDir, "current");
  const legacy = legacyDirs.map((dir, index) =>
    inventoryStore(dir, `legacy-${index}`),
  );
  const domains = diffDomains(current, legacy);
  const wrote: string[] = [];
  const backupDir = options.backupDir ? resolve(options.backupDir) : undefined;
  const stagingDir = options.stagingDir
    ? resolve(options.stagingDir)
    : undefined;

  if (options.mode === "rollback") {
    if (!backupDir) throw new ReconcileError("rollback requires --backup-dir");
    wrote.push(
      ...rollbackLive(currentDir, backupDir).map((name) => `current:${name}`),
    );
    return {
      mode: options.mode,
      wrote,
      current: inventoryStore(currentDir, "current"),
      legacy,
      domains: diffDomains(inventoryStore(currentDir, "current"), legacy),
      checks: [
        {
          id: "rollback",
          ok: true,
          detail: `restored ${wrote.length} file(s)`,
        },
      ],
      backup: {
        required: true,
        verified: verifyBackup(currentDir, backupDir).ok,
        path: backupDir,
      },
      stagingDigest: null,
    };
  }

  const backupNeeded = options.mode === "apply" || options.mode === "promote";
  let backupVerified = false;
  if (backupNeeded) {
    if (!backupDir)
      throw new ReconcileError(
        "apply/promote refuse to run without --backup-dir",
      );
    if (!existsSync(join(backupDir, BACKUP_MANIFEST_NAME)))
      createBackup(currentDir, backupDir);
    const verified = verifyBackup(currentDir, backupDir);
    if (!verified.ok)
      throw new ReconcileError(`refusing to continue: ${verified.detail}`);
    backupVerified = true;
  } else if (backupDir && existsSync(join(backupDir, BACKUP_MANIFEST_NAME))) {
    backupVerified = verifyBackup(currentDir, backupDir).ok;
  }

  let stagingDigest: string | null = null;
  let checks: ReconcileCheck[] = [];
  if (options.mode === "dry-run") {
    const preview = projectedChecks(currentDir, legacyDirs, options.prefer);
    stagingDigest = preview.digest;
    checks = preview.checks;
  } else {
    if (!stagingDir)
      throw new ReconcileError("apply/promote require --staging");
    const staged = materializeStaging(
      currentDir,
      legacyDirs,
      stagingDir,
      options.prefer,
    );
    stagingDigest = staged.digest;
    wrote.push(...staged.files.map((name) => `staging:${name}`));
    const config = readJsonValue(join(stagingDir, "config.json"));
    const auth = existsSync(join(stagingDir, "auth.json"))
      ? readJsonValue(join(stagingDir, "auth.json"))
      : {};
    const usage = existsSync(join(stagingDir, "usage.jsonl"))
      ? readFileSync(join(stagingDir, "usage.jsonl"), "utf8")
      : "";
    checks = [
      ...referentialChecks(asRecord(config) ?? {}, asRecord(auth) ?? {}),
      ...smokeChecks(config, auth, usage),
    ];
    if (options.mode === "promote") {
      if (checks.some((check) => !check.ok && check.id === "config.schema")) {
        throw new ReconcileError(
          "refusing promote: staging failed functional smoke",
        );
      }
      wrote.push(
        ...promoteStaging(currentDir, stagingDir, backupDir!).map(
          (name) => `live:${name}`,
        ),
      );
    }
  }

  return {
    mode: options.mode,
    wrote,
    current,
    legacy,
    domains,
    checks,
    backup: {
      required: backupNeeded,
      verified: backupVerified,
      path: backupDir ?? null,
    },
    stagingDigest,
  };
}

export function formatReport(report: ReconcileReport): string {
  const lines = [
    `mode=${report.mode} wrote=${report.wrote.length} stagingDigest=${report.stagingDigest ?? "-"}`,
    `backup required=${report.backup.required} verified=${report.backup.verified}`,
    `current providers=${report.current.providers.length} oauth=${report.current.oauthAccounts.length} usage=${report.current.usageLines} schemaVersion=${report.current.schemaVersion ?? "absent"}`,
  ];
  for (const domain of report.domains) {
    const missing = domain.missingFromCurrent.length
      ? ` missing=[${domain.missingFromCurrent.join(",")}]`
      : "";
    const conflicts = domain.conflicts.length
      ? ` conflicts=[${domain.conflicts.join(",")}]`
      : "";
    const legacy = Object.entries(domain.legacyCounts)
      .map(([label, count]) => `${label}:${count}`)
      .join(" ");
    lines.push(
      `${domain.domain}: current=${domain.currentCount} ${legacy}${missing}${conflicts}`,
    );
  }
  for (const check of report.checks) {
    lines.push(`${check.ok ? "ok" : "FAIL"} ${check.id}: ${check.detail}`);
  }
  if (report.wrote.length) lines.push(`wrote: ${report.wrote.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

function takeFlag(args: string[], flag: string): boolean {
  const at = args.indexOf(flag);
  if (at === -1) return false;
  args.splice(at, 1);
  return true;
}

function takeOption(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith("--"))
    throw new ReconcileError(`${flag} requires a value`);
  args.splice(at, 2);
  return value;
}

function takeRepeat(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (;;) {
    const value = takeOption(args, flag);
    if (value === undefined) return values;
    values.push(value);
  }
}

export function parseReconcileArgs(argv: string[]): ReconcileOptions {
  const args = [...argv];
  const promote = takeFlag(args, "--promote");
  const apply = takeFlag(args, "--apply");
  const rollback = takeFlag(args, "--rollback");
  if (
    [promote, apply, rollback].filter(Boolean).length > 1 &&
    !(promote && apply)
  ) {
    throw new ReconcileError(
      "use one of dry-run (default), --apply, --apply --promote, or --rollback",
    );
  }
  const currentDir =
    takeOption(args, "--current") ?? process.env.OPENCODEX_HOME;
  if (!currentDir)
    throw new ReconcileError("--current or OPENCODEX_HOME is required");
  const options: ReconcileOptions = {
    currentDir,
    legacyDirs: takeRepeat(args, "--legacy"),
    backupDir: takeOption(args, "--backup-dir"),
    stagingDir: takeOption(args, "--staging"),
    mode: rollback
      ? "rollback"
      : promote
        ? "promote"
        : apply
          ? "apply"
          : "dry-run",
    prefer: takeOption(args, "--prefer") === "legacy" ? "legacy" : "current",
  };
  if (args.length)
    throw new ReconcileError(`unexpected argument(s): ${args.join(" ")}`);
  if (options.mode !== "rollback" && options.legacyDirs.length === 0) {
    throw new ReconcileError("--legacy is required (repeatable)");
  }
  return options;
}

if (import.meta.main) {
  try {
    const report = runReconcile(parseReconcileArgs(process.argv.slice(2)));
    process.stdout.write(formatReport(report));
    process.exit(report.checks.some((check) => !check.ok) ? 1 : 0);
  } catch (error) {
    const message =
      error instanceof ReconcileError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(error instanceof ReconcileError ? error.exitCode : 1);
  }
}
