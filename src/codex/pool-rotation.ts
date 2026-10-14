import { dirname } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import type { OcxAccountPoolRotationStrategy } from "../types";

export const POOL_KEY_CODEX = "codex";
export const POOL_KEY_ANTHROPIC = "anthropic";
export const POOL_KEY_ANTIGRAVITY = "google-antigravity";
export const POOL_KEY_CURSOR = "cursor";
/** Filename for the process-restart rotation snapshot under the OCX home directory. */
export const POOL_ROTATION_STATE_FILENAME = "pool-rotation-state.json";

interface SelectionState {
  activeKey?: string;
  successes: number;
  currentWeights: Map<string, number>;
}

const selectionState = new Map<string, SelectionState>();

const DEFAULT_STICKY_LIMIT = 1;
const MIN_STICKY_LIMIT = 1;
const MAX_STICKY_LIMIT = 100;
const DEFAULT_STRATEGY: OcxAccountPoolRotationStrategy = "quota";
const VALID_STRATEGIES = new Set<OcxAccountPoolRotationStrategy>([
  "quota",
  "round-robin",
  "fill-first",
]);

/** Strict parse for management APIs — returns null instead of defaulting. */
export function parseAccountPoolStrategy(
  raw: unknown,
): OcxAccountPoolRotationStrategy | null {
  if (
    typeof raw === "string" &&
    VALID_STRATEGIES.has(raw as OcxAccountPoolRotationStrategy)
  ) {
    return raw as OcxAccountPoolRotationStrategy;
  }
  return null;
}

/** Strict parse for management APIs — returns null instead of defaulting. */
export function parseAccountPoolStickyLimit(raw: unknown): number | null {
  if (
    typeof raw === "number" &&
    Number.isInteger(raw) &&
    raw >= MIN_STICKY_LIMIT &&
    raw <= MAX_STICKY_LIMIT
  ) {
    return raw;
  }
  return null;
}

export function normalizeAccountPoolStrategy(
  raw: unknown,
): OcxAccountPoolRotationStrategy {
  return parseAccountPoolStrategy(raw) ?? DEFAULT_STRATEGY;
}

export function normalizeAccountPoolStickyLimit(raw: unknown): number {
  return parseAccountPoolStickyLimit(raw) ?? DEFAULT_STICKY_LIMIT;
}

function getOrCreateState(poolKey: string): SelectionState {
  let state = selectionState.get(poolKey);
  if (!state) {
    state = { successes: 0, currentWeights: new Map() };
    selectionState.set(poolKey, state);
  }
  return state;
}

function cloneSelectionState(state: SelectionState): SelectionState {
  return {
    activeKey: state.activeKey,
    successes: state.successes,
    currentWeights: new Map(state.currentWeights),
  };
}

function smoothWeightedIndex(ids: string[], state: SelectionState): number {
  let best = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  let total = 0;
  const weight = 1;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    const score = (state.currentWeights.get(id) ?? 0) + weight;
    state.currentWeights.set(id, score);
    total += weight;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  if (best >= 0) {
    const key = ids[best]!;
    state.currentWeights.set(key, (state.currentWeights.get(key) ?? 0) - total);
  }
  return best;
}

/**
 * Shared pick core. Mutates `state` the same way live resolve does; callers pass
 * either the live map entry or a scratch/clone for dry-run peek.
 */
function pickRoundRobinFromState(
  eligibleIds: string[],
  stickyLimit: number,
  state: SelectionState,
  commitSticky: boolean,
): string | null {
  if (eligibleIds.length === 0) return null;

  const limit = normalizeAccountPoolStickyLimit(stickyLimit);

  if (state.activeKey && eligibleIds.includes(state.activeKey)) {
    return state.activeKey;
  }

  if (state.activeKey) {
    delete state.activeKey;
    state.successes = 0;
  }

  const index = smoothWeightedIndex(eligibleIds, state);
  if (index < 0) return null;

  const picked = eligibleIds[index]!;
  if (commitSticky && limit > 1) {
    state.activeKey = picked;
    state.successes = 0;
  }
  return picked;
}

/**
 * Pick an eligible account using the pool's round-robin state, or return null for an
 * empty list. Reuse an eligible sticky account; new picks are held until stickyLimit
 * successes are noted when the limit exceeds 1. Invalid limits default to 1
 * (valid range: integers 1–100). Attempt to persist state when persistence is installed;
 * persistence failures are ignored.
 */
export function pickRoundRobinAccount(
  poolKey: string,
  eligibleIds: string[],
  stickyLimit: number,
): string | null {
  // Empty eligibility changes no selection state and must not create an empty
  // snapshot. A retained sticky account changes neither weights nor counters.
  if (eligibleIds.length === 0) return null;
  const state = getOrCreateState(poolKey);
  if (state.activeKey && eligibleIds.includes(state.activeKey)) {
    // A late or repeated persistence installation must first publish the
    // in-memory active account (and canonicalize a restored snapshot).
    // Subsequent identical sticky picks need no disk write.
    if (pendingSnapshotFlush) flushPoolRotationState();
    return state.activeKey;
  }
  const picked = pickRoundRobinFromState(eligibleIds, stickyLimit, state, true);
  // A new weighted selection or invalidated sticky account updates the ring.
  if (picked !== null) flushPoolRotationState();
  return picked;
}

/**
 * Dry-run of {@link pickRoundRobinAccount}: returns the same account resolve would
 * pick without advancing ring weights, activeKey, or successes.
 */
export function peekRoundRobinAccount(
  poolKey: string,
  eligibleIds: string[],
  stickyLimit: number,
): string | null {
  const live = selectionState.get(poolKey);
  const scratch = live
    ? cloneSelectionState(live)
    : { successes: 0, currentWeights: new Map<string, number>() };
  return pickRoundRobinFromState(eligibleIds, stickyLimit, scratch, false);
}

/**
 * Count a success in an existing pool, resetting the count when accountId changes.
 * Release the sticky account at stickyLimit successes (integers 1–100; otherwise 1)
 * and attempt persistence only on release. Do nothing if the pool has no state.
 */
export function notePoolRotationSuccess(
  poolKey: string,
  accountId: string,
  stickyLimit: number,
): void {
  const limit = normalizeAccountPoolStickyLimit(stickyLimit);
  const state = selectionState.get(poolKey);
  if (!state) return;
  const prevActive = state.activeKey;
  const prevSuccesses = state.successes;
  if (state.activeKey !== accountId) {
    state.activeKey = accountId;
    state.successes = 0;
  }
  state.successes += 1;
  if (state.successes >= limit) {
    delete state.activeKey;
    state.successes = 0;
    if (state.activeKey === prevActive && state.successes === prevSuccesses) return;
    flushPoolRotationState();
  }
}

/** Clear stickiness and attempt persistence only if accountId is the pool's active account. */
export function notePoolRotationFailure(
  poolKey: string,
  accountId: string,
): void {
  const state = selectionState.get(poolKey);
  if (state?.activeKey === accountId) {
    delete state.activeKey;
    state.successes = 0;
    flushPoolRotationState();
  }
}

/**
 * Force the next sticky/RR pick onto `accountId` (manual dashboard selection).
 * Clears sticky success counters and ring weights so the seeded account is held
 * for the next new-session pick before ordinary rotation resumes.
 * The seeded account must be eligible at pick time. Attempts persistence if installed.
 */
export function seedPoolRotationAccount(
  poolKey: string,
  accountId: string,
): void {
  const state = getOrCreateState(poolKey);
  state.activeKey = accountId;
  state.successes = 0;
  state.currentWeights.clear();
  flushPoolRotationState();
}

/**
 * Forget one pool's rotation state, or all pools when poolKey is omitted.
 * Attempt to persist the remaining state, removing the snapshot when no pools remain.
 */
export function clearPoolRotationState(poolKey?: string): void {
  if (poolKey === undefined) {
    selectionState.clear();
    flushPoolRotationState();
    return;
  }
  selectionState.delete(poolKey);
  flushPoolRotationState();
}

/* -------------------------------------------------------------------------- */
/* Persistence — rework of the historical per-pool `rrCursor` file contract.     */
/* The state still lives in memory for the running process; persistence is an     */
/* explicit, opt-in install so tests never touch disk and the server owns the    */
/* file layout.                                                                  */
/* -------------------------------------------------------------------------- */

interface SerializedSelectionState {
  activeKey?: string;
  successes: number;
  currentWeights: Record<string, number>;
}

interface SerializedRotationState {
  version: 1;
  pools: Record<string, SerializedSelectionState>;
}

let persistedRotationPath: string | null = null;
// A restored snapshot may need canonicalization; a new path may not yet contain
// the in-memory sticky state. Clear only after a successful atomic write.
let pendingSnapshotFlush = false;

/**
 * Attempt an atomic snapshot write with 0o600 permissions when persistence is installed.
 * Empty state removes the snapshot and temporary file. I/O failures are swallowed.
 */
function flushPoolRotationState(): void {
  if (!persistedRotationPath) return;
  const path = persistedRotationPath;
  const tmpPath = `${path}.tmp`;
  try {
    if (selectionState.size === 0) {
      rmSync(path, { force: true });
      rmSync(tmpPath, { force: true });
      pendingSnapshotFlush = false;
      return;
    }
    const pools: Record<string, SerializedSelectionState> = {};
    for (const [poolKey, state] of selectionState) {
      pools[poolKey] = {
        ...(state.activeKey !== undefined
          ? { activeKey: state.activeKey }
          : {}),
        successes: state.successes,
        currentWeights: Object.fromEntries(state.currentWeights.entries()),
      };
    }
    const payload: SerializedRotationState = { version: 1, pools };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(tmpPath, JSON.stringify(payload), { mode: 0o600 });
    try {
      chmodSync(tmpPath, 0o600);
    } catch {
      /* platform may ignore chmod */
    }
    renameSync(tmpPath, path);
    pendingSnapshotFlush = false;
  } catch {
    /* persistence is best-effort and must never break rotation */
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* ignored */
    }
  }
}

/**
 * Restore one pool entry, coercing successes and weights to numbers. Missing successes
 * default to zero; invalid active keys or nonfinite/negative successes return null,
 * and nonfinite weights are skipped. Numeric coercion errors propagate to the loader.
 */
function parseSerializedSelectionState(raw: unknown): SelectionState | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as {
    activeKey?: unknown;
    successes?: unknown;
    currentWeights?: unknown;
  };
  const activeKey =
    candidate.activeKey === undefined ? undefined : candidate.activeKey;
  if (activeKey !== undefined && typeof activeKey !== "string") return null;
  const successes = Number(candidate.successes ?? 0);
  if (!Number.isFinite(successes) || successes < 0) return null;
  const currentWeights = new Map<string, number>();
  if (
    candidate.currentWeights &&
    typeof candidate.currentWeights === "object"
  ) {
    for (const [id, value] of Object.entries(
      candidate.currentWeights as Record<string, unknown>,
    )) {
      const weight = Number(value);
      if (!Number.isFinite(weight)) continue;
      currentWeights.set(id, weight);
    }
  }
  return {
    ...(activeKey !== undefined ? { activeKey } : {}),
    successes,
    currentWeights,
  };
}

/**
 * Load valid pool entries from a version-1 snapshot.
 * Missing files, unsupported versions, and read, parse, and conversion errors are
 * ignored, retaining any entries already loaded.
 */
function loadPoolRotationStateFromDisk(): void {
  if (!persistedRotationPath) return;
  const path = persistedRotationPath;
  if (!existsSync(path)) return;
  try {
    const parsed = JSON.parse(
      readFileSync(path, "utf-8"),
    ) as SerializedRotationState;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.version !== 1 ||
      !parsed.pools ||
      typeof parsed.pools !== "object"
    )
      return;
    for (const [poolKey, rawState] of Object.entries(parsed.pools)) {
      const state = parseSerializedSelectionState(rawState);
      if (state) selectionState.set(poolKey, state);
    }
  } catch {
    /* a corrupt file is treated as absent: rotation stays in-process from scratch */
  }
}

/**
 * Install disk persistence for all pool rotation state. Intended to be called once by
 * `startServer()` with a path under `getConfigDir()`. Only loads from disk when the process
 * has no in-memory state yet (a fresh server start): a process that already resolved a pick
 * keeps its live ring and merely gains flushing.
 * Does not write a snapshot on install; snapshot read and parse failures are ignored.
 */
export function installPoolRotationPersistence(filePath: string): void {
  persistedRotationPath = filePath;
  pendingSnapshotFlush = true;
  if (selectionState.size === 0) {
    loadPoolRotationStateFromDisk();
  }
}

/** Detach disk persistence without clearing memory or deleting the snapshot. Mostly for isolated tests. */
export function uninstallPoolRotationPersistence(): void {
  persistedRotationPath = null;
  pendingSnapshotFlush = false;
}
