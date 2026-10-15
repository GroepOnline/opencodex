const AUTO_RELOAD_KEY = "opencodex:chunk-reload-attempted";
const API_BASE = import.meta.env.VITE_API_BASE || "";
const FULL_GIT_SHA = /^[a-f0-9]{40}$/i;

export interface ChunkRecoveryOptions {
  clientSha: string | null;
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  storage: Pick<Storage, "getItem" | "setItem">;
  reload: () => void;
}

let currentAttempt: Promise<boolean> | null = null;

/**
 * Match known browser chunk-load failure messages using Error.message or String(error).
 * Errors from reading or converting the message propagate to the caller.
 */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|unable to preload css|chunkloaderror|loading chunk [\w.-]+ failed/i.test(
    message,
  );
}

/** Return a trimmed, full 40-character hexadecimal gitSha, or null if absent or invalid. */
function readGitSha(data: unknown): string | null {
  if (!data || typeof data !== "object" || !("gitSha" in data)) return null;
  const value = (data as { gitSha?: unknown }).gitSha;
  return typeof value === "string" && FULL_GIT_SHA.test(value.trim())
    ? value.trim()
    : null;
}

/**
 * Reload for a chunk-load failure only when /healthz reports a different full checkout SHA.
 * clientSha must be the GUI build's full 40-character hexadecimal SHA; comparisons ignore case.
 * Eligible concurrent calls share the pending attempt and its original options.
 *
 * Store the target SHA in the supplied storage before calling reload, suppressing another
 * attempt for that same target while its marker remains. Use session storage to retain the
 * marker across document reloads; a thrown reload leaves it set.
 *
 * Resolve true when reload returns normally, or false when recovery is ineligible, already
 * attempted, or a fetch, JSON, storage, or reload operation fails. Errors while extracting
 * the error message propagate synchronously before recovery starts.
 */
export function recoverStaleChunk(
  error: unknown,
  options: ChunkRecoveryOptions,
): Promise<boolean> {
  const clientSha = options.clientSha;
  if (!isChunkLoadError(error) || !clientSha || !FULL_GIT_SHA.test(clientSha)) {
    return Promise.resolve(false);
  }
  if (currentAttempt) return currentAttempt;

  currentAttempt = (async () => {
    try {
      const response = await options.fetcher(`${API_BASE}/healthz`, {
        cache: "no-store",
      });
      if (!response.ok) return false;
      const runtimeSha = readGitSha(await response.json());
      if (!runtimeSha || runtimeSha.toLowerCase() === clientSha.toLowerCase()) {
        return false;
      }
      const attemptedSha = options.storage.getItem(AUTO_RELOAD_KEY);
      if (attemptedSha?.toLowerCase() === runtimeSha.toLowerCase())
        return false;
      options.storage.setItem(AUTO_RELOAD_KEY, runtimeSha);
      options.reload();
      return true;
    } catch {
      // Network, storage, and parsing failures leave the actionable boundary visible.
      return false;
    }
  })();

  const attempt = currentAttempt;
  void attempt.then(() => {
    if (currentAttempt === attempt) currentAttempt = null;
  });
  return attempt;
}
