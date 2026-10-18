import { dirname, join } from "node:path";
import { getConfigDir } from "../config";
import { withFileLock, withFileLockAsync, type FileLockOptions } from "../lib/file-lock";

/**
 * Cross-process mutex for the Claude Desktop 3P library. `ocx claude desktop apply`, the dashboard's
 * "Save and apply" and `ocx claude desktop sync` all rewrite the same `_meta.json` + profile pair;
 * without a shared lock a concurrent pair can interleave and leave a profile that no longer matches
 * its metadata. The lock lives in the OCX config dir, never in Desktop's own library directory.
 *
 * Two flavours share one lock file and one acquisition protocol (see `../lib/file-lock`):
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

/** Fold caller options and defaults into one immutable description of the lock being taken. */
function resolveLock(options: DesktopLibraryLockOptions): FileLockOptions {
  const configDir = options.path ? dirname(options.path) : getConfigDir();
  return {
    path: options.path ?? join(configDir, "claude-desktop-library.lock"),
    waitMs: options.waitMs ?? DEFAULT_WAIT_MS,
    staleMs: options.staleMs ?? DEFAULT_STALE_MS,
    recordOwned: options.recordOwned ?? !options.path,
    timeoutError: () => new DesktopLibraryLockTimeoutError(),
  };
}

/**
 * Run `fn` while holding the Desktop library lock, blocking the thread while the lock is busy.
 * Prefer {@link withDesktopLibraryLockAsync} anywhere the event loop must stay responsive.
 */
export function withDesktopLibraryLock<T>(fn: () => T, options: DesktopLibraryLockOptions = {}): T {
  return withFileLock(fn, resolveLock(options));
}

/**
 * Run `fn` while holding the Desktop library lock, waiting for a busy lock without blocking the
 * event loop. Safe to call from HTTP handlers; the critical section itself still runs to completion.
 */
export async function withDesktopLibraryLockAsync<T>(
  fn: () => T | Promise<T>,
  options: DesktopLibraryLockOptions = {},
): Promise<T> {
  return withFileLockAsync(fn, resolveLock(options));
}
