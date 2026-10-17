import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { recordOwnedConfigPath } from "./config-ownership";

/**
 * Lightweight cross-process mutex backed by one exclusively created lock file. The holder records
 * its pid, a per-acquisition token and a timestamp; a holder past `staleMs`, or whose process is
 * gone, may be taken over, and release only removes a lock that still carries the caller's token.
 *
 * - `withFileLock` blocks the thread while it waits. Use it only where the critical section is short
 *   or the caller is already synchronous.
 * - `withFileLockAsync` yields the event loop between attempts.
 */
export interface FileLockOptions {
  /** Absolute lock file path. Its parent directory is created when missing. */
  path: string;
  /** How long to wait for a busy lock before failing. */
  waitMs: number;
  /** A holder older than this, or whose process is gone, may be taken over. */
  staleMs: number;
  /** Record the lock file in the config ownership manifest of its parent directory. */
  recordOwned: boolean;
  /** Error raised when the lock stayed busy for the whole wait window. */
  timeoutError: () => Error;
}

const POLL_MS = 50;

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
function tryAcquire(options: FileLockOptions, token: string): boolean {
  for (;;) {
    try {
      const fd = openSync(options.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { writeSync(fd, JSON.stringify({ pid: process.pid, token, at: Date.now() })); } finally { closeSync(fd); }
      if (options.recordOwned) {
        // Ownership bookkeeping only matters for crash residue; it must never fail a held lock.
        try { recordOwnedConfigPath(dirname(options.path), options.path); } catch { /* best effort */ }
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stale = staleHolder(options.path, options.staleMs);
    // Re-read before stealing so a holder that just replaced the stale lock is never removed.
    if (stale !== null && readHolder(options.path) === stale) {
      try { unlinkSync(options.path); } catch { /* another process stole it first */ }
      continue;
    }
    return false;
  }
}

/** Remove the lock only when it still carries this caller's token. */
function release(path: string, token: string): void {
  const holder = readHolder(path);
  try {
    if (holder !== null && (JSON.parse(holder) as { token?: unknown }).token === token) unlinkSync(path);
  } catch { /* a lock we no longer own must not be removed */ }
}

/** Run `fn` while holding the lock, blocking the thread while the lock is busy. */
export function withFileLock<T>(fn: () => T, options: FileLockOptions): T {
  const token = randomUUID();
  const deadline = Date.now() + options.waitMs;
  mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
  while (!tryAcquire(options, token)) {
    if (Date.now() >= deadline) throw options.timeoutError();
    pause(POLL_MS);
  }
  try {
    return fn();
  } finally {
    release(options.path, token);
  }
}

/** Run `fn` while holding the lock, waiting for a busy lock without blocking the event loop. */
export async function withFileLockAsync<T>(fn: () => T | Promise<T>, options: FileLockOptions): Promise<T> {
  const token = randomUUID();
  const deadline = Date.now() + options.waitMs;
  mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
  while (!tryAcquire(options, token)) {
    if (Date.now() >= deadline) throw options.timeoutError();
    await new Promise<void>(resolve => setTimeout(resolve, POLL_MS));
  }
  try {
    return await fn();
  } finally {
    release(options.path, token);
  }
}
