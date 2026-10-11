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
 */
export interface DesktopLibraryLockOptions {
  path?: string;
  waitMs?: number;
  staleMs?: number;
}

const DEFAULT_WAIT_MS = 10_000;
const DEFAULT_STALE_MS = 60_000;

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

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

export function withDesktopLibraryLock<T>(fn: () => T, options: DesktopLibraryLockOptions = {}): T {
  const configDir = options.path ? dirname(options.path) : getConfigDir();
  const path = options.path ?? join(configDir, "claude-desktop-library.lock");
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { writeSync(fd, JSON.stringify({ pid: process.pid, token, at: Date.now() })); } finally { closeSync(fd); }
      if (!options.path) recordOwnedConfigPath(configDir, path);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stale = staleHolder(path, staleMs);
    // Re-read before stealing so a holder that just replaced the stale lock is never removed.
    if (stale !== null && readHolder(path) === stale) {
      try { unlinkSync(path); } catch { /* another process stole it first */ }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error("Claude Desktop library is being updated by another opencodex process; retry in a moment");
    }
    pause(50);
  }
  try {
    return fn();
  } finally {
    const holder = readHolder(path);
    try {
      if (holder !== null && (JSON.parse(holder) as { token?: unknown }).token === token) unlinkSync(path);
    } catch { /* a lock we no longer own must not be removed */ }
  }
}
