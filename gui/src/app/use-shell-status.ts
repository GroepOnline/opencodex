import { useKeyedClientResource } from "../client-resource";
import { loadSessionIdentity, type SessionIdentity } from "../session-identity";

const API_BASE = import.meta.env.VITE_API_BASE || "";

function readRuntimeVersion(data: unknown): string | null {
  if (!data || typeof data !== "object" || !("version" in data)) return null;
  const version = (data as { version?: unknown }).version;
  return typeof version === "string" && version.length > 0 ? version : null;
}

/** Only the authenticated dashboard shell may mount status and identity polling. */
export function useShellStatus() {
  const healthPoll = useKeyedClientResource(
    `app-healthz:${API_BASE}`,
    [],
    async (signal) => {
      const res = await fetch(`${API_BASE}/healthz`, { signal });
      // Non-OK healthz is a technical fetch failure — the status code is the payload.
      if (!res.ok) throw new Error(String(res.status));
      return { version: readRuntimeVersion(await res.json()) };
    },
    { pollMs: 30_000 },
  );
  const identityPoll = useKeyedClientResource<SessionIdentity>(
    `app-whoami:${API_BASE}`,
    [],
    () => loadSessionIdentity(),
  );

  const displayedVersion: string = healthPoll.data?.version ?? __APP_VERSION__;
  // null = first poll still in flight: no stamp until the first verdict.
  const proxyOnline: boolean | null = healthPoll.error
    ? false
    : healthPoll.data
      ? true
      : null;
  return {
    displayedVersion,
    proxyOnline,
    identityEmail: identityPoll.data?.email ?? null,
  };
}
