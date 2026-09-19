/**
 * Authentik OIDC consumer for the management GUI.
 *
 * When OIDC_ISSUER + OIDC_CLIENT_ID are set, a verified Authentik ID token
 * (Authorization Bearer) or an `ocx_oidc` session cookie authorizes human
 * GUI/API use without the separate ocx_admin_* prompt. Authorization-code
 * + PKCE (`GET /oauth/login` → `/oauth/callback`) requires a readable
 * OIDC_CLIENT_SECRET_FILE. Data-plane /v1/* stays on service-api-token.
 * Fail closed when env is unset or the token is invalid.
 */

import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";

export type OidcIdentity = {
  email: string;
  sub: string;
};

type Jwk = JsonWebKey & { kid?: string; kty: string };

type OidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
};

type JwksCache = { keys: Jwk[]; fetchedAt: number };
type DiscoveryCache = { discovery: OidcDiscovery; fetchedAt: number };

type PendingFlow = {
  verifier: string;
  nonce: string;
  redirectUri: string;
  expiresAt: number;
};

type OidcSessionRecord = {
  identity: OidcIdentity;
  expiresAt: number;
};

const JWKS_TTL_MS = 60 * 60_000;
const DISCOVERY_TTL_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 3_000;
const PENDING_TTL_MS = 10 * 60_000;
const PENDING_LIMIT = 64;
const SESSION_LIMIT = 128;
const SESSION_TTL_CAP_MS = 60 * 60_000;
const SECRET_FILE_MAX_BYTES = 4_096;
const OIDC_COOKIE = "ocx_oidc";
const OIDC_SCOPES = "openid profile email";

let jwksCache: JwksCache | null = null;
let discoveryCache: DiscoveryCache | null = null;
const pendingFlows = new Map<string, PendingFlow>();
const oidcSessions = new Map<string, OidcSessionRecord>();

type FetchFn = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
let fetchOverrideForTests: FetchFn | null = null;

type VerifyFn = (req: Request) => Promise<OidcIdentity | null>;
let verifyOverrideForTests: VerifyFn | null = null;

export function resetOidcStateForTests(): void {
  jwksCache = null;
  discoveryCache = null;
  pendingFlows.clear();
  oidcSessions.clear();
  fetchOverrideForTests = null;
  verifyOverrideForTests = null;
}

export function setOidcFetchForTests(fn: FetchFn | null): void {
  fetchOverrideForTests = fn;
}

export function setVerifyOidcRequestForTests(fn: VerifyFn | null): void {
  verifyOverrideForTests = fn;
}

function oidcFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return (fetchOverrideForTests ?? fetch)(input, init);
}

export function oidcIssuer(): string | null {
  const raw = Bun.env.OIDC_ISSUER?.trim();
  return raw ? normalizeIssuer(raw) : null;
}

export function oidcClientId(): string | null {
  const raw = Bun.env.OIDC_CLIENT_ID?.trim();
  return raw || null;
}

export function oidcConfigured(): boolean {
  return !!oidcIssuer() && !!oidcClientId();
}

export function oidcRedirectUri(): string | null {
  const raw = Bun.env.OIDC_REDIRECT_URI?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeIssuer(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function issuerEquals(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  return normalizeIssuer(actual) === normalizeIssuer(expected);
}

function loopbackHostnames(): Set<string> {
  return new Set(["localhost", "127.0.0.1", "::1"]);
}

function isLoopbackHostname(hostname: string): boolean {
  return loopbackHostnames().has(
    hostname.trim().toLowerCase().replace(/\.$/, ""),
  );
}

export function oidcTrustedHosts(): Set<string> {
  const hosts = new Set<string>();
  const raw = Bun.env.OIDC_ALLOWED_HOSTS?.trim() || "";
  for (const part of raw.split(",")) {
    const host = part.trim().toLowerCase().replace(/\.$/, "");
    if (host) hosts.add(host);
  }
  const redirect = oidcRedirectUri();
  if (redirect) {
    try {
      const hostname = new URL(redirect).hostname.toLowerCase();
      hosts.add(hostname);
      if (isLoopbackHostname(hostname)) {
        for (const extra of loopbackHostnames()) hosts.add(extra);
      }
    } catch {
      /* ignore unparseable redirect */
    }
  }
  return hosts;
}

export function isOidcTrustedHost(hostname: string | undefined): boolean {
  if (!hostname) return false;
  return oidcTrustedHosts().has(
    hostname.trim().toLowerCase().replace(/\.$/, ""),
  );
}

export function oidcCodeFlowConfigured(): boolean {
  return oidcConfigured() && !!oidcRedirectUri() && !!readClientSecret();
}

function readClientSecret(): string | null {
  const path = Bun.env.OIDC_CLIENT_SECRET_FILE?.trim();
  if (!path) return null;
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > SECRET_FILE_MAX_BYTES
    ) {
      return null;
    }
    const secret = readFileSync(path, "utf8").trim();
    return secret.length > 0 ? secret : null;
  } catch {
    return null;
  }
}

function requestHostname(req: Request): string | undefined {
  const host = req.headers.get("Host");
  if (!host) return undefined;
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function requestIsHttps(req: Request): boolean {
  const forwarded = req.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  if (forwarded === "https") return true;
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

function discoveryUrl(issuer: string): string {
  return `${normalizeIssuer(issuer)}.well-known/openid-configuration`;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await oidcFetch(url, {
      ...init,
      headers: { Accept: "application/json", ...(init?.headers ?? {}) },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`OIDC fetch failed: ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function loadDiscovery(): Promise<OidcDiscovery> {
  const issuer = oidcIssuer();
  if (!issuer) throw new Error("OIDC issuer is not configured");
  const now = Date.now();
  if (discoveryCache && now - discoveryCache.fetchedAt < DISCOVERY_TTL_MS) {
    return discoveryCache.discovery;
  }
  const body = (await fetchJson(
    discoveryUrl(issuer),
  )) as Partial<OidcDiscovery>;
  if (
    typeof body.issuer !== "string" ||
    typeof body.authorization_endpoint !== "string" ||
    typeof body.token_endpoint !== "string" ||
    typeof body.jwks_uri !== "string"
  ) {
    throw new Error("OIDC discovery document is incomplete");
  }
  if (!issuerEquals(body.issuer, issuer)) {
    throw new Error("OIDC discovery issuer mismatch");
  }
  const discovery: OidcDiscovery = {
    issuer: normalizeIssuer(body.issuer),
    authorization_endpoint: body.authorization_endpoint,
    token_endpoint: body.token_endpoint,
    jwks_uri: body.jwks_uri,
    end_session_endpoint:
      typeof body.end_session_endpoint === "string"
        ? body.end_session_endpoint
        : undefined,
  };
  discoveryCache = { discovery, fetchedAt: now };
  return discovery;
}

async function loadJwks(): Promise<Jwk[]> {
  const now = Date.now();
  if (jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS)
    return jwksCache.keys;
  const discovery = await loadDiscovery();
  const body = (await fetchJson(discovery.jwks_uri)) as { keys?: Jwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  if (keys.length === 0) throw new Error("OIDC JWKS empty");
  jwksCache = { keys, fetchedAt: now };
  return keys;
}

function decodeJwtPart(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

function audMatches(claim: unknown, expected: string): boolean {
  if (typeof claim === "string") return claim === expected;
  if (Array.isArray(claim)) return claim.some((entry) => entry === expected);
  return false;
}

function identityFromPayload(payload: {
  email?: unknown;
  preferred_username?: unknown;
  sub?: unknown;
}): OidcIdentity | null {
  const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!sub) return null;
  const emailRaw =
    (typeof payload.email === "string" && payload.email.trim()) ||
    (typeof payload.preferred_username === "string" &&
      payload.preferred_username.trim()) ||
    "";
  if (!emailRaw) return null;
  return { email: emailRaw.toLowerCase(), sub };
}

type OidcJwtHeader = { alg?: string; kid?: string };
type OidcJwtPayload = {
  aud?: unknown;
  iss?: string;
  exp?: number;
  nonce?: string;
  email?: unknown;
  preferred_username?: unknown;
  sub?: unknown;
};

function parseOidcJwt(token: string): {
  headerB64: string;
  payloadB64: string;
  signatureB64: string;
  header: OidcJwtHeader;
  payload: OidcJwtPayload;
} | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  try {
    return {
      headerB64,
      payloadB64,
      signatureB64,
      header: decodeJwtPart(headerB64) as OidcJwtHeader,
      payload: decodeJwtPart(payloadB64) as OidcJwtPayload,
    };
  } catch {
    return null;
  }
}

function oidcClaimsMatch(
  payload: OidcJwtPayload,
  issuer: string,
  clientId: string,
  expectedNonce?: string,
): boolean {
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) {
    return false;
  }
  if (!issuerEquals(payload.iss, issuer)) return false;
  if (!audMatches(payload.aud, clientId)) return false;
  if (expectedNonce && payload.nonce !== expectedNonce) return false;
  return true;
}

async function verifyRs256Signature(
  headerB64: string,
  payloadB64: string,
  signatureB64: string,
  kid: string,
): Promise<boolean> {
  const keys = await loadJwks();
  const jwk = keys.find((key) => key.kid === kid);
  if (!jwk) return false;
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = Buffer.from(signatureB64, "base64url");
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data);
}

export async function verifyOidcIdToken(
  token: string,
  expectedNonce?: string,
): Promise<OidcIdentity | null> {
  const issuer = oidcIssuer();
  const clientId = oidcClientId();
  if (!issuer || !clientId) return null;

  const parsed = parseOidcJwt(token);
  if (!parsed || parsed.header.alg !== "RS256" || !parsed.header.kid) {
    return null;
  }
  if (!oidcClaimsMatch(parsed.payload, issuer, clientId, expectedNonce)) {
    return null;
  }
  const identity = identityFromPayload(parsed.payload);
  if (!identity) return null;

  try {
    const ok = await verifyRs256Signature(
      parsed.headerB64,
      parsed.payloadB64,
      parsed.signatureB64,
      parsed.header.kid,
    );
    return ok ? identity : null;
  } catch (error) {
    console.warn(
      "OIDC verification failed",
      error instanceof Error ? error.message : "unknown error",
    );
    return null;
  }
}

function extractOidcBearer(req: Request): string | null {
  const header = req.headers.get("authorization")?.trim();
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function extractOidcCookie(req: Request): string | null {
  const cookie = req.headers.get("cookie") || req.headers.get("Cookie") || "";
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === OIDC_COOKIE && rest.length) {
      const value = rest.join("=").trim();
      if (value) return value;
    }
  }
  return null;
}

function pruneMaps(
  map: Map<string, { expiresAt: number }>,
  limit: number,
  now = Date.now(),
): void {
  for (const [key, record] of map) {
    if (record.expiresAt <= now) map.delete(key);
  }
  while (map.size >= limit) {
    const oldest = map.keys().next().value as string | undefined;
    if (!oldest) break;
    map.delete(oldest);
  }
}

function lookupSession(token: string, now = Date.now()): OidcIdentity | null {
  pruneMaps(oidcSessions, SESSION_LIMIT, now);
  const session = oidcSessions.get(token);
  if (!session || session.expiresAt <= now) {
    if (session) oidcSessions.delete(token);
    return null;
  }
  return session.identity;
}

export async function verifyOidcRequest(
  req: Request,
): Promise<OidcIdentity | null> {
  if (verifyOverrideForTests) return verifyOverrideForTests(req);
  if (!oidcConfigured()) return null;

  const bearer = extractOidcBearer(req);
  if (bearer) {
    if (bearer.startsWith("ocx_oidc_")) return lookupSession(bearer);
    if (bearer.includes(".")) return verifyOidcIdToken(bearer);
  }

  const cookie = extractOidcCookie(req);
  if (cookie) return lookupSession(cookie);
  return null;
}

function securityHeaders(): Record<string, string> {
  return {
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "frame-ancestors 'none'",
    "Cache-Control": "no-store",
  };
}

function textResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...securityHeaders(),
    },
  });
}

function redirectResponse(location: string, cookie?: string): Response {
  const headers = new Headers({ Location: location, ...securityHeaders() });
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function sessionCookie(req: Request, token: string, maxAge: number): string {
  const secure = requestIsHttps(req) ? "; Secure" : "";
  return `${OIDC_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function clearCookie(req: Request): string {
  const secure = requestIsHttps(req) ? "; Secure" : "";
  return `${OIDC_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function hostAllowedForFlow(req: Request): boolean {
  const hostname = requestHostname(req);
  if (!hostname) return false;
  return isLoopbackHostname(hostname) || isOidcTrustedHost(hostname);
}

export async function handleOidcAuthorize(req: Request): Promise<Response> {
  if (!oidcConfigured()) return textResponse(404, "OIDC is not configured");
  if (!oidcCodeFlowConfigured()) {
    return textResponse(503, "OIDC client secret file is not configured");
  }
  if (!hostAllowedForFlow(req)) {
    return textResponse(403, "OIDC login is not available on this host");
  }

  const redirectUri = oidcRedirectUri();
  const clientId = oidcClientId();
  if (!redirectUri || !clientId) {
    return textResponse(503, "OIDC client secret file is not configured");
  }

  try {
    const discovery = await loadDiscovery();
    pruneMaps(pendingFlows, PENDING_LIMIT);
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    pendingFlows.set(state, {
      verifier,
      nonce,
      redirectUri,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });
    const authorize = new URL(discovery.authorization_endpoint);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("scope", OIDC_SCOPES);
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("nonce", nonce);
    authorize.searchParams.set("code_challenge", pkceChallenge(verifier));
    authorize.searchParams.set("code_challenge_method", "S256");
    return redirectResponse(authorize.toString());
  } catch (error) {
    console.warn(
      "OIDC authorize start failed",
      error instanceof Error ? error.message : "unknown error",
    );
    return textResponse(502, "OIDC discovery failed");
  }
}

function mintSession(
  identity: OidcIdentity,
  expSeconds?: number,
): {
  token: string;
  maxAge: number;
} {
  pruneMaps(oidcSessions, SESSION_LIMIT);
  const token = `ocx_oidc_${randomBytes(32).toString("base64url")}`;
  const fromToken =
    typeof expSeconds === "number"
      ? Math.max(0, expSeconds * 1000 - Date.now())
      : SESSION_TTL_CAP_MS;
  const ttl = Math.min(fromToken || SESSION_TTL_CAP_MS, SESSION_TTL_CAP_MS);
  oidcSessions.set(token, { identity, expiresAt: Date.now() + ttl });
  return { token, maxAge: Math.max(1, Math.floor(ttl / 1000)) };
}

function idTokenExpSeconds(token: string): number | undefined {
  try {
    const payload = decodeJwtPart(token.split(".")[1] ?? "") as {
      exp?: number;
    };
    return typeof payload.exp === "number" ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

export async function handleOidcCallback(req: Request): Promise<Response> {
  if (!oidcConfigured()) return textResponse(404, "OIDC is not configured");
  if (!oidcCodeFlowConfigured()) {
    return textResponse(503, "OIDC client secret file is not configured");
  }
  if (!hostAllowedForFlow(req)) {
    return textResponse(403, "OIDC callback is not available on this host");
  }

  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return textResponse(400, "OIDC callback URL is invalid");
  }
  if (url.searchParams.get("error")) {
    return textResponse(400, "OIDC authorization was denied");
  }
  const code = url.searchParams.get("code")?.trim();
  const state = url.searchParams.get("state")?.trim();
  if (!code || !state)
    return textResponse(400, "OIDC callback is missing code or state");

  pruneMaps(pendingFlows, PENDING_LIMIT);
  const pending = pendingFlows.get(state);
  pendingFlows.delete(state);
  if (!pending) return textResponse(400, "OIDC callback state is invalid");

  const secret = readClientSecret();
  const clientId = oidcClientId();
  if (!secret || !clientId) {
    return textResponse(503, "OIDC client secret file is not configured");
  }

  try {
    const discovery = await loadDiscovery();
    const credentials = Buffer.from(`${clientId}:${secret}`, "utf8").toString(
      "base64",
    );
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirectUri,
      client_id: clientId,
      code_verifier: pending.verifier,
    });
    const tokenResponse = (await fetchJson(discovery.token_endpoint, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    })) as { id_token?: unknown };
    const idToken =
      typeof tokenResponse.id_token === "string" ? tokenResponse.id_token : "";
    const identity = await verifyOidcIdToken(idToken, pending.nonce);
    if (!identity) return textResponse(401, "OIDC identity token is invalid");
    const session = mintSession(identity, idTokenExpSeconds(idToken));
    return redirectResponse(
      "/",
      sessionCookie(req, session.token, session.maxAge),
    );
  } catch (error) {
    console.warn(
      "OIDC callback failed",
      error instanceof Error ? error.message : "unknown error",
    );
    return textResponse(502, "OIDC token exchange failed");
  }
}

export async function handleOidcLogout(req: Request): Promise<Response> {
  const cookie = extractOidcCookie(req);
  if (cookie) oidcSessions.delete(cookie);

  let location = "/";
  const redirect = oidcRedirectUri();
  if (redirect) {
    try {
      location = new URL("/", redirect).toString();
    } catch {
      location = "/";
    }
  }

  if (oidcConfigured()) {
    try {
      const discovery = await loadDiscovery();
      const clientId = oidcClientId();
      if (discovery.end_session_endpoint && clientId) {
        const endSession = new URL(discovery.end_session_endpoint);
        endSession.searchParams.set("client_id", clientId);
        endSession.searchParams.set("post_logout_redirect_uri", location);
        return redirectResponse(endSession.toString(), clearCookie(req));
      }
    } catch {
      /* local cookie clear is enough */
    }
  }
  return redirectResponse(location, clearCookie(req));
}
