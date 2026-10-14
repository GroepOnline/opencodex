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

/** Browser-specific dynamic-import failures; ordinary render errors never trigger a probe. */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|unable to preload css|chunkloaderror|loading chunk [\w.-]+ failed/i.test(
    message,
  );
}

function readGitSha(data: unknown): string | null {
  if (!data || typeof data !== "object" || !("gitSha" in data)) return null;
  const value = (data as { gitSha?: unknown }).gitSha;
  return typeof value === "string" && FULL_GIT_SHA.test(value.trim())
    ? value.trim()
    : null;
}

/**
 * Reload only after public runtime provenance proves the loaded GUI is from another checkout.
 * Store the target SHA in session storage so each distinct deployment can recover once without
 * looping when a reload still serves a stale GUI bundle.
 */
export function recoverStaleChunk(
  error: unknown,
  options: ChunkRecoveryOptions,
): Promise<boolean> {
  if (
    !isChunkLoadError(error) ||
    !options.clientSha ||
    !FULL_GIT_SHA.test(options.clientSha)
  ) {
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
      if (
        !runtimeSha ||
        runtimeSha.toLowerCase() === options.clientSha.toLowerCase()
      ) {
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
