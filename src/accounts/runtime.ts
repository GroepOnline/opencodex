/**
 * Persistable account runtime at account-runtime.json.
 *
 * Routing Maps remain the hot path. This file is the restart-safety ledger:
 * write-through from rotate-on-429 / Codex outcome / needsReauth / pool RR
 * cursor, hydrate on start.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, backupInvalidConfig, getConfigDir, hardenConfigDir } from "../config";
import { recordOwnedConfigPath } from "../lib/config-ownership";

export const ACCOUNT_RUNTIME_FILENAME = "account-runtime.json";
export const ACCOUNT_RUNTIME_VERSION = 1 as const;

export type AccountState =
  | "UNKNOWN"
  | "HEALTHY"
  | "RATE_LIMITED"
  | "COOLDOWN"
  | "EXPIRED"
  | "AUTH_FAILED"
  | "DISABLED";

export type AccountReason =
  | "observed_ok"
  | "retry_after"
  | "quota_window"
  | "overload_529"
  | "token_expired"
  | "refresh_failed"
  | "unauthorized"
  | "forbidden"
  | "operator_disabled"
  | "operator_paused"
  | "missing_credential"
  | "missing_project"
  | "never_observed";

export interface AccountRuntime {
  provider: string;
  accountId: string;
  state: AccountState;
  reason: AccountReason;
  until?: number;
  generation?: number;
  updatedAt: number;
}

export type AccountRuntimeWrite = {
  provider: string;
  accountId: string;
  state: AccountState;
  reason: AccountReason;
  until?: number;
  now?: number;
};

export interface PoolRotationCursor {
  activeKey?: string;
  successes: number;
  weights: Record<string, number>;
  updatedAt: number;
}

export type PoolRotationCursorWrite = {
  activeKey?: string;
  successes: number;
  weights: Record<string, number>;
};

type AccountRuntimeFile = {
  version: typeof ACCOUNT_RUNTIME_VERSION;
  accounts: Record<string, AccountRuntime>;
  rotation: Record<string, PoolRotationCursor>;
};

const ACCOUNT_STATES = new Set<AccountState>([
  "UNKNOWN",
  "HEALTHY",
  "RATE_LIMITED",
  "COOLDOWN",
  "EXPIRED",
  "AUTH_FAILED",
  "DISABLED",
]);

const ACCOUNT_REASONS = new Set<AccountReason>([
  "observed_ok",
  "retry_after",
  "quota_window",
  "overload_529",
  "token_expired",
  "refresh_failed",
  "unauthorized",
  "forbidden",
  "operator_disabled",
  "operator_paused",
  "missing_credential",
  "missing_project",
  "never_observed",
]);

const LEGAL_TRANSITIONS: Record<AccountState, ReadonlySet<AccountState>> = {
  UNKNOWN: new Set(["HEALTHY", "RATE_LIMITED", "COOLDOWN", "EXPIRED", "AUTH_FAILED", "DISABLED"]),
  HEALTHY: new Set(["RATE_LIMITED", "COOLDOWN", "EXPIRED", "AUTH_FAILED", "DISABLED"]),
  RATE_LIMITED: new Set(["HEALTHY", "COOLDOWN", "AUTH_FAILED", "RATE_LIMITED"]),
  COOLDOWN: new Set(["HEALTHY", "AUTH_FAILED", "COOLDOWN", "RATE_LIMITED"]),
  EXPIRED: new Set(["HEALTHY", "AUTH_FAILED"]),
  AUTH_FAILED: new Set(["HEALTHY"]),
  DISABLED: new Set(["HEALTHY", "UNKNOWN"]),
};

let cachedDir: string | null = null;
let cachedStore: AccountRuntimeFile | null = null;

export function getAccountRuntimePath(): string {
  return join(getConfigDir(), ACCOUNT_RUNTIME_FILENAME);
}

export function accountRuntimeKey(provider: string, accountId: string): string {
  return `${provider}\0${accountId}`;
}

export function keyRuntimeProvider(providerName: string): string {
  return `key:${providerName}`;
}

export function parseKeyRuntimeProvider(provider: string): string | null {
  return provider.startsWith("key:") ? provider.slice(4) : null;
}

export function transition(from: AccountState | undefined, to: AccountState): AccountState {
  const current = from ?? "UNKNOWN";
  if (current === to) return to;
  if (LEGAL_TRANSITIONS[current].has(to)) return to;
  return current;
}

function emptyStore(): AccountRuntimeFile {
  return { version: ACCOUNT_RUNTIME_VERSION, accounts: {}, rotation: {} };
}

function isAccountRuntimeCacheOpen(): boolean {
  return cachedStore !== null && cachedDir === getConfigDir();
}

function isFiniteEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeRecord(value: unknown): AccountRuntime | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<AccountRuntime>;
  if (typeof raw.provider !== "string" || raw.provider.length === 0) return null;
  if (typeof raw.accountId !== "string" || raw.accountId.length === 0) return null;
  if (!ACCOUNT_STATES.has(raw.state as AccountState)) return null;
  if (!ACCOUNT_REASONS.has(raw.reason as AccountReason)) return null;
  if (!isFiniteEpoch(raw.updatedAt)) return null;
  const record: AccountRuntime = {
    provider: raw.provider,
    accountId: raw.accountId,
    state: raw.state as AccountState,
    reason: raw.reason as AccountReason,
    updatedAt: raw.updatedAt,
  };
  if (isFiniteEpoch(raw.until)) record.until = raw.until;
  if (typeof raw.generation === "number" && Number.isFinite(raw.generation)) {
    record.generation = raw.generation;
  }
  return record;
}

function normalizeRotation(value: unknown): PoolRotationCursor | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<PoolRotationCursor>;
  if (typeof raw.successes !== "number" || !Number.isFinite(raw.successes) || raw.successes < 0) {
    return null;
  }
  if (!raw.weights || typeof raw.weights !== "object" || Array.isArray(raw.weights)) return null;
  if (!isFiniteEpoch(raw.updatedAt)) return null;
  const weights: Record<string, number> = {};
  for (const [id, weight] of Object.entries(raw.weights)) {
    if (id.length === 0 || typeof weight !== "number" || !Number.isFinite(weight)) continue;
    weights[id] = weight;
  }
  const cursor: PoolRotationCursor = {
    successes: Math.floor(raw.successes),
    weights,
    updatedAt: raw.updatedAt,
  };
  if (typeof raw.activeKey === "string" && raw.activeKey.length > 0) {
    cursor.activeKey = raw.activeKey;
  }
  return cursor;
}

function rotationEqual(
  left: PoolRotationCursor | undefined,
  right: PoolRotationCursorWrite,
): boolean {
  if (!left) return false;
  if (left.activeKey !== right.activeKey) return false;
  if (left.successes !== right.successes) return false;
  const leftKeys = Object.keys(left.weights);
  const rightKeys = Object.keys(right.weights);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (left.weights[key] !== right.weights[key]) return false;
  }
  return true;
}

function readStoreFromDisk(): AccountRuntimeFile {
  const path = getAccountRuntimePath();
  if (!existsSync(path)) return emptyStore();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AccountRuntimeFile>;
    if (parsed?.version !== ACCOUNT_RUNTIME_VERSION || !parsed.accounts || typeof parsed.accounts !== "object") {
      return emptyStore();
    }
    const accounts: Record<string, AccountRuntime> = {};
    for (const [key, value] of Object.entries(parsed.accounts)) {
      const record = normalizeRecord(value);
      if (!record) continue;
      accounts[key] = record;
    }
    const rotation: Record<string, PoolRotationCursor> = {};
    if (parsed.rotation && typeof parsed.rotation === "object") {
      for (const [key, value] of Object.entries(parsed.rotation)) {
        if (key.length === 0) continue;
        const cursor = normalizeRotation(value);
        if (!cursor) continue;
        rotation[key] = cursor;
      }
    }
    return { version: ACCOUNT_RUNTIME_VERSION, accounts, rotation };
  } catch {
    backupInvalidConfig(path);
    return emptyStore();
  }
}

function storeForCurrentHome(forceReload = false): AccountRuntimeFile {
  const dir = getConfigDir();
  if (forceReload || cachedDir !== dir || !cachedStore) {
    cachedDir = dir;
    cachedStore = readStoreFromDisk();
  }
  return cachedStore;
}

function writeStore(store: AccountRuntimeFile): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  hardenConfigDir();
  const path = getAccountRuntimePath();
  recordOwnedConfigPath(dir, path);
  atomicWriteFile(path, `${JSON.stringify(store, null, 2)}\n`);
  cachedDir = dir;
  cachedStore = store;
}

export function reloadAccountRuntimeStore(): AccountRuntimeFile {
  return storeForCurrentHome(true);
}

export function listAccountRuntimes(now = Date.now()): AccountRuntime[] {
  const store = storeForCurrentHome();
  const out: AccountRuntime[] = [];
  for (const record of Object.values(store.accounts)) {
    if (isActiveRuntime(record, now)) out.push(record);
  }
  return out;
}

export function getAccountRuntime(
  provider: string,
  accountId: string,
  now = Date.now(),
): AccountRuntime | null {
  const record = storeForCurrentHome().accounts[accountRuntimeKey(provider, accountId)];
  if (!record) return null;
  return isActiveRuntime(record, now) ? record : null;
}

export function isActiveRuntime(record: AccountRuntime, now = Date.now()): boolean {
  if (record.state === "HEALTHY" || record.state === "UNKNOWN") return false;
  if (record.state === "RATE_LIMITED" || record.state === "COOLDOWN" || record.state === "EXPIRED") {
    return isFiniteEpoch(record.until) && record.until > now;
  }
  return record.state === "AUTH_FAILED" || record.state === "DISABLED";
}

export function persistAccountRuntime(input: AccountRuntimeWrite): AccountRuntime | null {
  try {
    const now = input.now ?? Date.now();
    const store = storeForCurrentHome();
    const key = accountRuntimeKey(input.provider, input.accountId);
    const current = store.accounts[key];
    const nextState = transition(current?.state, input.state);
    if (nextState === "HEALTHY" || nextState === "UNKNOWN") {
      if (!current) return null;
      const next = { ...store, accounts: { ...store.accounts } };
      delete next.accounts[key];
      writeStore(next);
      return null;
    }
    const until = isFiniteEpoch(input.until) ? input.until : current?.until;
    if (
      (nextState === "RATE_LIMITED" || nextState === "COOLDOWN" || nextState === "EXPIRED")
      && (!isFiniteEpoch(until) || until <= now)
    ) {
      if (!current) return null;
      const next = { ...store, accounts: { ...store.accounts } };
      delete next.accounts[key];
      writeStore(next);
      return null;
    }
    const reason = nextState === current?.state ? (input.reason ?? current.reason) : input.reason;
    const record: AccountRuntime = {
      provider: input.provider,
      accountId: input.accountId,
      state: nextState,
      reason: nextState === current?.state ? reason : input.reason,
      updatedAt: now,
      ...(isFiniteEpoch(until) && nextState !== "AUTH_FAILED" && nextState !== "DISABLED"
        ? { until }
        : {}),
      ...(current?.generation !== undefined ? { generation: current.generation } : {}),
    };
    if (
      current
      && current.state === record.state
      && current.reason === record.reason
      && current.until === record.until
    ) {
      return current;
    }
    writeStore({
      ...store,
      accounts: { ...store.accounts, [key]: record },
    });
    return record;
  } catch (error) {
    console.warn(
      `[account-runtime] persist failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export function persistPoolCooldown(input: {
  provider: string;
  accountId: string;
  cooldownUntil: number;
  cooldownSource: "retry-after" | "reset-derived" | "default";
  now?: number;
}): void {
  persistAccountRuntime({
    provider: input.provider,
    accountId: input.accountId,
    state: input.cooldownSource === "retry-after" ? "RATE_LIMITED" : "COOLDOWN",
    reason: input.cooldownSource === "retry-after" ? "retry_after" : "quota_window",
    until: input.cooldownUntil,
    now: input.now,
  });
}

export function persistAccountAuthFailed(input: {
  provider: string;
  accountId: string;
  reason?: Extract<AccountReason, "refresh_failed" | "unauthorized" | "forbidden">;
  now?: number;
}): void {
  persistAccountRuntime({
    provider: input.provider,
    accountId: input.accountId,
    state: "AUTH_FAILED",
    reason: input.reason ?? "refresh_failed",
    now: input.now,
  });
}

export function persistAccountHealthy(provider: string, accountId: string, now?: number): void {
  persistAccountRuntime({
    provider,
    accountId,
    state: "HEALTHY",
    reason: "observed_ok",
    now,
  });
}

export function listPoolRotationCursors(): Record<string, PoolRotationCursor> {
  return { ...storeForCurrentHome().rotation };
}

export function persistPoolRotationCursor(
  poolKey: string,
  snapshot: PoolRotationCursorWrite,
  now = Date.now(),
): PoolRotationCursor | null {
  if (!poolKey || !isAccountRuntimeCacheOpen()) return null;
  try {
    const store = cachedStore!;
    const current = store.rotation[poolKey];
    if (rotationEqual(current, snapshot)) return current;
    const cursor: PoolRotationCursor = {
      successes: snapshot.successes,
      weights: { ...snapshot.weights },
      updatedAt: now,
      ...(snapshot.activeKey ? { activeKey: snapshot.activeKey } : {}),
    };
    writeStore({
      ...store,
      rotation: { ...store.rotation, [poolKey]: cursor },
    });
    return cursor;
  } catch (error) {
    console.warn(
      `[account-runtime] rotation persist failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export function persistPoolRotationCleared(poolKey?: string): void {
  if (!isAccountRuntimeCacheOpen()) return;
  try {
    const store = cachedStore!;
    if (poolKey === undefined) {
      if (Object.keys(store.rotation).length === 0) return;
      writeStore({ ...store, rotation: {} });
      return;
    }
    if (!(poolKey in store.rotation)) return;
    const rotation = { ...store.rotation };
    delete rotation[poolKey];
    writeStore({ ...store, rotation });
  } catch (error) {
    console.warn(
      `[account-runtime] rotation persist failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function resetAccountRuntimeCacheForTests(): void {
  cachedDir = null;
  cachedStore = null;
}
