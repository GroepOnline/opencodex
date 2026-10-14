import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { getConfigDir } from "../config";
import { recordOwnedConfigPath } from "../lib/config-ownership";

/**
 * Cross-process mutex for the Claude Desktop 3P library. `ocx claude desktop apply`, the dashboard's
 * "Save and apply" and `ocx claude desktop sync` all rewrite the same `_meta.json` + profile pair;
 * without a shared lock a concurrent pair can interleave and leave a profile that no longer matches
 * its metadata. The lock lives in the OCX config dir, never in Desktop's own library directory.
 *
 * Two flavours share one lock file and one acquisition protocol:
 * - `withDesktopLibraryLock` blocks the thread while it waits. Use it only from synchronous CLI paths.
 * - `withDesktopLibraryLockAsync` yields the event loop between attempts. Use it from the proxy's
 *   HTTP handlers and from async CLI paths, where a blocking wait would stall every other request.
 */
export interface DesktopLibraryLockOptions {
  /** Absolute lock file path. Defaults to `<config dir>/claude-desktop-library.lock`. */
  path?: string;
  /** How long to wait for a busy lock before failing. */
  waitMs?: number;
  /** A holder older than this, or whose process is gone, may be taken over. */
  staleMs?: number;
  /** Record the lock file in the config ownership manifest. Defaults to true for the default path. */
  recordOwned?: boolean;
}

/** Raised when the lock stayed busy for the whole wait window. */
export class DesktopLibraryLockTimeoutError extends Error {
  constructor() {
    super("Claude Desktop library is being updated by another opencodex process; retry in a moment");
    this.name = "DesktopLibraryLockTimeoutError";
  }
}

const DEFAULT_WAIT_MS = 10_000;
const DEFAULT_STALE_MS = 60_000;
const POLL_MS = 50;

interface ResolvedLock {
  configDir: string;
  path: string;
  waitMs: number;
  staleMs: number;
  record: boolean;
  token: string;
}

/** Fold caller options and defaults into one immutable description of the lock being taken. */
function resolveLock(options: DesktopLibraryLockOptions): ResolvedLock {
  const configDir = options.path ? dirname(options.path) : getConfigDir();
  return {
    configDir,
    path: options.path ?? join(configDir, "claude-desktop-library.lock"),
    waitMs: options.waitMs ?? DEFAULT_WAIT_MS,
    staleMs: options.staleMs ?? DEFAULT_STALE_MS,
    record: options.recordOwned ?? !options.path,
    token: randomUUID(),
  };
}

/** Blocking sleep; only the synchronous lock flavour may use it. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** True when `pid` names a live process (EPERM means it exists but belongs to someone else). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read a lock file only when it is a small regular file; a link or oversized file is never trusted. */
function readHolder(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** A holder is stale when it is past the deadline or its process is gone; returns its raw text. */
function staleHolder(path: string, staleMs: number): string | null {
  const text = readHolder(path);
  let at = 0;
  let pid = 0;
  if (text !== null) {
    try {
      const value = JSON.parse(text) as { at?: unknown; pid?: unknown };
      at = typeof value.at === "number" ? value.at : 0;
      pid = typeof value.pid === "number" ? value.pid : 0;
    } catch { /* fall through to the mtime check */ }
  }
  if (!at) {
    try { at = lstatSync(path).mtimeMs; } catch { return null; }
  }
  if (Date.now() - at > staleMs || (pid > 0 && pid !== process.pid && !pidAlive(pid))) return text ?? "";
  return null;
}

/**
 * One acquisition attempt. Returns true when this caller now holds the lock; false when it is busy.
 * A stale holder is removed and the attempt retried immediately.
 */
function tryAcquire(lock: ResolvedLock): boolean {
  for (;;) {
    try {
      const fd = openSync(lock.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { writeSync(fd, JSON.stringify({ pid: process.pid, token: lock.token, at: Date.now() })); } finally { closeSync(fd); }
      if (lock.record) {
        // Ownership bookkeeping only matters for crash residue; it must never fail a held lock.
        try { recordOwnedConfigPath(lock.configDir, lock.path); } catch { /* best effort */ }
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stale = staleHolder(lock.path, lock.staleMs);
    // Re-read before stealing so a holder that just replaced the stale lock is never removed.
    if (stale !== null && readHolder(lock.path) === stale) {
      try { unlinkSync(lock.path); } catch { /* another process stole it first */ }
      continue;
    }
    return false;
  }
}

/** Remove the lock only when it still carries this caller's token. */
function release(lock: ResolvedLock): void {
  const holder = readHolder(lock.path);
  try {
    if (holder !== null && (JSON.parse(holder) as { token?: unknown }).token === lock.token) unlinkSync(lock.path);
  } catch { /* a lock we no longer own must not be removed */ }
}

/**
 * Run `fn` while holding the Desktop library lock, blocking the thread while the lock is busy.
 * Prefer {@link withDesktopLibraryLockAsync} anywhere the event loop must stay responsive.
 */
export function withDesktopLibraryLock<T>(fn: () => T, options: DesktopLibraryLockOptions = {}): T {
  const lock = resolveLock(options);
  const deadline = Date.now() + lock.waitMs;
  mkdirSync(lock.configDir, { recursive: true, mode: 0o700 });
  while (!tryAcquire(lock)) {
    if (Date.now() >= deadline) throw new DesktopLibraryLockTimeoutError();
    pause(POLL_MS);
  }
  try {
    return fn();
  } finally {
    release(lock);
  }
}

/**
 * Run `fn` while holding the Desktop library lock, waiting for a busy lock without blocking the
 * event loop. Safe to call from HTTP handlers; the critical section itself still runs to completion.
 */
export async function withDesktopLibraryLockAsync<T>(
  fn: () => T | Promise<T>,
  options: DesktopLibraryLockOptions = {},
): Promise<T> {
  const lock = resolveLock(options);
  const deadline = Date.now() + lock.waitMs;
  mkdirSync(lock.configDir, { recursive: true, mode: 0o700 });
  while (!tryAcquire(lock)) {
    if (Date.now() >= deadline) throw new DesktopLibraryLockTimeoutError();
    await new Promise<void>(resolve => setTimeout(resolve, POLL_MS));
  }
  try {
    return await fn();
  } finally {
    release(lock);
  }
}
