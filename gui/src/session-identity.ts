export type SessionIdentitySource = "cf-access" | "oidc" | "none";

export type SessionIdentity = {
  email: string | null;
  source: SessionIdentitySource;
};

type IdentityPayload = {
  email?: unknown;
  source?: unknown;
};

function asEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!email || !email.includes("@") || email.length > 254) return null;
  return email;
}

function asSource(value: unknown): SessionIdentitySource {
  if (value === "cf-access" || value === "oidc") return value;
  return "none";
}

export function parseSessionIdentity(payload: unknown): SessionIdentity {
  if (!payload || typeof payload !== "object") {
    return { email: null, source: "none" };
  }
  const body = payload as IdentityPayload;
  return {
    email: asEmail(body.email),
    source: asSource(body.source),
  };
}

async function readJson(url: string): Promise<unknown | null> {
  try {
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Signed-in human identity for the dashboard chrome.
 * Management `/api/whoami` is preferred; Cloudflare Access get-identity is a
 * same-origin fallback when the proxy has not minted an email. Never reads tokens.
 */
export async function loadSessionIdentity(): Promise<SessionIdentity> {
  const managed = parseSessionIdentity(await readJson("/api/whoami"));
  if (managed.email) return managed;

  const access = await readJson("/cdn-cgi/access/get-identity");
  const email = asEmail(
    access && typeof access === "object"
      ? (access as IdentityPayload).email
      : null,
  );
  if (email) return { email, source: "cf-access" };
  return managed;
}
