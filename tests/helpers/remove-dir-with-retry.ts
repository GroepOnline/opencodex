import { rmSync } from "node:fs";

const RETRYABLE_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE"]);

/**
 * Remove a temp directory, retrying on transient file-lock errors.
 *
 * On Windows a just-closed SQLite/log handle can keep a file locked for a few
 * milliseconds, so a single `rmSync` in `afterEach` flakes with EBUSY. Retry
 * with a short backoff (forcing a GC so lingering handles finalize), but still
 * throw once attempts are exhausted so a real handle leak stays visible.
 */
export async function removeDirWithRetry(path: string, attempts = 10, baseDelayMs = 50): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !RETRYABLE_CODES.has(code) || attempt >= attempts) throw error;
      Bun.gc(true);
      await Bun.sleep(baseDelayMs * attempt);
    }
  }
}
