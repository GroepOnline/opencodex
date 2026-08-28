/**
 * Cloudflare Access JWT verification for the management GUI.
 *
 * When CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD are set, a valid Access assertion
 * (edge → origin header or CF_Authorization cookie) authorizes human GUI/API
 * use without the separate ocx_admin_* prompt. Data-plane /v1/* stays on
 * service-api-token. Fail closed when env is unset or JWT is invalid.
 */

export type CfAccessIdentity = {
  email: string;
  sub: string;
};

type Jwk = JsonWebKey & { kid?: string; kty: string };

type JwksCache = {
  keys: Jwk[];
  fetchedAt: number;
};

const JWKS_TTL_MS = 60 * 60_000;
const JWKS_FETCH_TIMEOUT_MS = 3_000;
let jwksCache: JwksCache | null = null;

export function resetCfAccessJwksCacheForTests(): void {
  jwksCache = null;
}

export function cfAccessConfigured(): boolean {
  return (
    !!Bun.env.CF_ACCESS_TEAM_DOMAIN?.trim() && !!Bun.env.CF_ACCESS_AUD?.trim()
  );
}

export function cfAccessTrustedHosts(): Set<string> {
  const raw =
    Bun.env.CF_ACCESS_ALLOWED_HOSTS?.trim() ||
    Bun.env.CF_ACCESS_HOST?.trim() ||
    "";
  return new Set(
    raw
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isCfAccessTrustedHost(hostname: string | undefined): boolean {
  if (!hostname) return false;
  return cfAccessTrustedHosts().has(
    hostname.trim().toLowerCase().replace(/\.$/, ""),
  );
}

function teamDomain(): string {
  return Bun.env
    .CF_ACCESS_TEAM_DOMAIN!.trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

function audience(): string {
  return Bun.env.CF_ACCESS_AUD!.trim();
}

function extractAccessJwt(req: Request): string | null {
  const assertion =
    req.headers.get("cf-access-jwt-assertion")?.trim() ||
    req.headers.get("Cf-Access-Jwt-Assertion")?.trim();
  if (assertion) return assertion;

  const cookie = req.headers.get("cookie") || req.headers.get("Cookie") || "";
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "CF_Authorization" && rest.length) {
      const value = rest.join("=").trim();
      if (value) return value;
    }
  }
  return null;
}

function decodeJwtPart(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

async function loadJwks(): Promise<Jwk[]> {
  const now = Date.now();
  if (jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS)
    return jwksCache.keys;
  const url = `https://${teamDomain()}/cdn-cgi/access/certs`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JWKS_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok)
    throw new Error(`CF Access JWKS fetch failed: ${response.status}`);
  const body = (await response.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  if (keys.length === 0) throw new Error("CF Access JWKS empty");
  jwksCache = { keys, fetchedAt: now };
  return keys;
}

function audMatches(claim: unknown, expected: string): boolean {
  if (typeof claim === "string") return claim === expected;
  if (Array.isArray(claim)) return claim.some((entry) => entry === expected);
  return false;
}

type VerifyFn = (req: Request) => Promise<CfAccessIdentity | null>;
let verifyOverrideForTests: VerifyFn | null = null;

/** Test-only seam — production path always uses real JWKS verification. */
export function setVerifyCfAccessRequestForTests(fn: VerifyFn | null): void {
  verifyOverrideForTests = fn;
}

export async function verifyCfAccessRequest(
  req: Request,
): Promise<CfAccessIdentity | null> {
  if (verifyOverrideForTests) return verifyOverrideForTests(req);
  if (!cfAccessConfigured()) return null;
  const token = extractAccessJwt(req);
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { alg?: string; kid?: string };
  let payload: {
    aud?: unknown;
    iss?: string;
    exp?: number;
    email?: string;
    sub?: string;
  };
  try {
    header = decodeJwtPart(headerB64) as typeof header;
    payload = decodeJwtPart(payloadB64) as typeof payload;
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now())
    return null;
  if (payload.iss !== `https://${teamDomain()}`) return null;
  if (!audMatches(payload.aud, audience())) return null;
  const email =
    typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!email || !sub) return null;

  try {
    const keys = await loadJwks();
    const jwk = keys.find((key) => key.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = Buffer.from(signatureB64, "base64url");
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature,
      data,
    );
    if (!ok) return null;
    return { email, sub };
  } catch (error) {
    console.warn(
      "Cloudflare Access verification failed",
      error instanceof Error ? error.message : "unknown error",
    );
    return null;
  }
}
