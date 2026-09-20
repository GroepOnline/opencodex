/**
 * Authentik OIDC consumer for the management GUI.
 *
 * When OIDC_ISSUER + OIDC_CLIENT_ID are set, a verified Authentik ID token
 * (Authorization Bearer) or an `ocx_oidc` session cookie authorizes human
 * GUI/API use without the separate ocx_admin_* prompt. Authorization-code
 * + PKCE (`GET /oauth/login` → `/oauth/callback`) requires a readable
 * OIDC_CLIENT_SECRET_FILE. The login transaction is bound to the browser
 * with an HttpOnly flow cookie (state/nonce/PKCE/browserBinding/returnTo).
 * Data-plane /v1/* stays on service-api-token.
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
  introspection_endpoint?: string;
};

type JwksCache = { keys: Jwk[]; fetchedAt: number };
type DiscoveryCache = { discovery: OidcDiscovery; fetchedAt: number };

type PendingFlow = {
  verifier: string;
  nonce: string;
  redirectUri: string;
  browserBinding: string;
  returnTo: string;
  expiresAt: number;
};

type OidcSessionRecord = {
  identity: OidcIdentity;
  accessToken?: string;
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
const FLOW_COOKIE = "ocx_oidc_flow";
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
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
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
    const loopbackHttp =
      parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname);
    if (
      (parsed.protocol !== "https:" && !loopbackHttp) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== "/oauth/callback"
    ) {
      return null;
    }
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

function assertTrustedIssuerEndpoint(endpoint: string, issuer: string): void {
  const url = new URL(endpoint);
  const issuerUrl = new URL(issuer);
  if (
    url.protocol !== "https:" ||
    url.origin !== issuerUrl.origin ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("OIDC endpoint is not on the trusted issuer origin");
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
  for (const endpoint of [
    body.authorization_endpoint,
    body.token_endpoint,
    body.jwks_uri,
    body.end_session_endpoint,
    body.introspection_endpoint,
  ]) {
    if (endpoint) assertTrustedIssuerEndpoint(endpoint, issuer);
  }
  const discovery: OidcDiscovery = {
    issuer: body.issuer,
    authorization_endpoint: body.authorization_endpoint,
    token_endpoint: body.token_endpoint,
    jwks_uri: body.jwks_uri,
    introspection_endpoint:
      typeof body.introspection_endpoint === "string"
        ? body.introspection_endpoint
        : undefined,
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
  iat?: number;
  nbf?: number;
  azp?: string;
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
  if (
    typeof payload.exp !== "number" ||
    !Number.isFinite(payload.exp) ||
    payload.exp * 1000 <= Date.now()
  ) {
    return false;
  }
  if (
    typeof payload.iat !== "number" ||
    !Number.isFinite(payload.iat) ||
    payload.iat * 1000 > Date.now() + 30_000
  ) {
    return false;
  }
  if (
    payload.nbf !== undefined &&
    (typeof payload.nbf !== "number" ||
      !Number.isFinite(payload.nbf) ||
      payload.nbf * 1000 > Date.now())
  ) {
    return false;
  }
  if (payload.azp !== undefined && payload.azp !== clientId) return false;
  if (
    Array.isArray(payload.aud) &&
    payload.aud.length > 1 &&
    payload.azp !== clientId
  ) {
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

function extractOidcCookie(
  req: Request,
  cookieName = OIDC_COOKIE,
): string | null {
  const cookie = req.headers.get("cookie") || req.headers.get("Cookie") || "";
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === cookieName && rest.length) {
      const value = rest.join("=").trim();
      if (value) return value;
    }
  }
  return null;
}

export function oidcBrowserSessionPresent(req: Request): boolean {
  const cookie = extractOidcCookie(req);
  if (cookie?.startsWith("ocx_oidc_")) return true;
  const bearer = extractOidcBearer(req);
  return !!bearer?.startsWith("ocx_oidc_");
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

async function sessionStillActive(
  session: OidcSessionRecord,
): Promise<boolean> {
  if (!session.accessToken) return true;
  try {
    const discovery = await loadDiscovery();
    const secret = readClientSecret();
    const clientId = oidcClientId();
    if (!discovery.introspection_endpoint || !secret || !clientId) {
      return true;
    }
    const credentials = Buffer.from(`${clientId}:${secret}`, "utf8").toString(
      "base64",
    );
    const result = (await fetchJson(discovery.introspection_endpoint, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        token: session.accessToken,
        token_type_hint: "access_token",
      }),
    })) as { active?: unknown; sub?: unknown; client_id?: unknown };
    return (
      result.active === true &&
      (result.sub === undefined || result.sub === session.identity.sub) &&
      (result.client_id === undefined || result.client_id === clientId)
    );
  } catch {
    // Local TTL + logout still revoke. An IdP blip must not drop every session.
    return true;
  }
}

async function lookupSession(
  token: string,
  now = Date.now(),
): Promise<OidcIdentity | null> {
  pruneMaps(oidcSessions, SESSION_LIMIT, now);
  const session = oidcSessions.get(token);
  if (!session || session.expiresAt <= now) {
    if (session) oidcSessions.delete(token);
    return null;
  }
  if (!(await sessionStillActive(session))) {
    oidcSessions.delete(token);
    return null;
  }
  return session.identity;
}

export async function verifyOidcRequest(
  req: Request,
): Promise<OidcIdentity | null> {
  if (verifyOverrideForTests) return verifyOverrideForTests(req);
  if (!oidcConfigured() || !isOidcTrustedHost(requestHostname(req))) {
    return null;
  }

  const cookie = extractOidcCookie(req);
  if (cookie) {
    const identity = await lookupSession(cookie);
    if (identity) return identity;
  }

  const bearer = extractOidcBearer(req);
  if (bearer?.startsWith("ocx_oidc_")) return lookupSession(bearer);
  if (bearer?.includes(".")) return verifyOidcIdToken(bearer);
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

function redirectResponse(
  location: string,
  cookies?: string | string[],
): Response {
  const headers = new Headers({ Location: location, ...securityHeaders() });
  if (typeof cookies === "string") headers.append("Set-Cookie", cookies);
  else if (cookies) {
    for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  }
  return new Response(null, { status: 302, headers });
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function sessionCookie(
  req: Request,
  token: string,
  maxAge: number,
  name = OIDC_COOKIE,
): string {
  const secure =
    oidcRedirectUri()?.startsWith("https:") || requestIsHttps(req)
      ? "; Secure"
      : "";
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function clearCookies(req: Request): string[] {
  return [
    sessionCookie(req, "", 0, OIDC_COOKIE),
    sessionCookie(req, "", 0, FLOW_COOKIE),
  ];
}

function requestHostMatchesRedirect(req: Request, redirect: string): boolean {
  const requestHost = req.headers.get("host")?.toLowerCase();
  if (!requestHost) return false;
  const redirectUrl = new URL(redirect);
  if (requestHost === redirectUrl.host.toLowerCase()) return true;
  try {
    const parsed = new URL(`http://${requestHost}`);
    if (parsed.hostname.toLowerCase() !== redirectUrl.hostname.toLowerCase()) {
      return false;
    }
    const requestPort = parsed.port || (requestIsHttps(req) ? "443" : "80");
    const redirectPort =
      redirectUrl.port || (redirectUrl.protocol === "https:" ? "443" : "80");
    return requestPort === redirectPort;
  } catch {
    return false;
  }
}

function hostAllowedForFlow(req: Request): boolean {
  const hostname = requestHostname(req);
  if (!hostname || !isOidcTrustedHost(hostname)) return false;
  const redirect = oidcRedirectUri();
  if (!redirect) return false;
  if (requestHostMatchesRedirect(req, redirect)) return true;
  // Loopback canaries bind a random port while redirect stays on :10100.
  return (
    isLoopbackHostname(hostname) &&
    isLoopbackHostname(new URL(redirect).hostname)
  );
}

function returnToHasUnsafeChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (value[i] === "\\" || code < 32 || code === 127) return true;
  }
  return false;
}

export function safeOidcReturnTo(value: string | null | undefined): string {
  const requested = value || "/";
  if (
    requested.startsWith("/") &&
    !requested.startsWith("//") &&
    !returnToHasUnsafeChars(requested)
  ) {
    return requested;
  }
  return "/";
}

export function oidcShouldChallengeDashboard(req: Request): boolean {
  if (!oidcCodeFlowConfigured()) return false;
  const hostname = requestHostname(req);
  return (
    !!hostname && isOidcTrustedHost(hostname) && !isLoopbackHostname(hostname)
  );
}

export function oidcDashboardChallengeResponse(req: Request): Response {
  let path = "/";
  try {
    const url = new URL(req.url);
    path = `${url.pathname}${url.search}`;
  } catch {
    /* default */
  }
  return redirectResponse(
    `/oauth/login?return_to=${encodeURIComponent(safeOidcReturnTo(path))}`,
  );
}

function requireOidcCodeFlow(
  req: Request,
  unavailableMessage: string,
): Response | null {
  if (!oidcConfigured()) return textResponse(404, "OIDC is not configured");
  if (!oidcCodeFlowConfigured()) {
    return textResponse(503, "OIDC client secret file is not configured");
  }
  if (!hostAllowedForFlow(req)) {
    return textResponse(403, unavailableMessage);
  }
  return null;
}

export async function handleOidcAuthorize(req: Request): Promise<Response> {
  const gated = requireOidcCodeFlow(
    req,
    "OIDC login is not available on this host",
  );
  if (gated) return gated;

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
    const browserBinding = randomBytes(32).toString("base64url");
    const requestedReturn = new URL(req.url).searchParams.get("return_to");
    const returnTo = safeOidcReturnTo(requestedReturn);
    pendingFlows.set(state, {
      browserBinding,
      returnTo,
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
    return redirectResponse(
      authorize.toString(),
      sessionCookie(
        req,
        browserBinding,
        Math.floor(PENDING_TTL_MS / 1000),
        FLOW_COOKIE,
      ),
    );
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
  accessToken: string | undefined,
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
  const ttl = Math.min(fromToken, SESSION_TTL_CAP_MS);
  oidcSessions.set(token, {
    identity,
    ...(accessToken ? { accessToken } : {}),
    expiresAt: Date.now() + ttl,
  });
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

function readCallbackQuery(
  req: Request,
):
  | { ok: true; code: string; state: string }
  | { ok: false; response: Response } {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return {
      ok: false,
      response: textResponse(400, "OIDC callback URL is invalid"),
    };
  }
  if (url.searchParams.get("error")) {
    return {
      ok: false,
      response: textResponse(400, "OIDC authorization was denied"),
    };
  }
  const code = url.searchParams.get("code")?.trim();
  const state = url.searchParams.get("state")?.trim();
  if (!code || !state) {
    return {
      ok: false,
      response: textResponse(400, "OIDC callback is missing code or state"),
    };
  }
  return { ok: true, code, state };
}

function consumePendingFlow(
  req: Request,
  state: string,
): PendingFlow | Response {
  pruneMaps(pendingFlows, PENDING_LIMIT);
  const pending = pendingFlows.get(state);
  if (
    !pending ||
    extractOidcCookie(req, FLOW_COOKIE) !== pending.browserBinding
  ) {
    return textResponse(400, "OIDC callback state is invalid");
  }
  pendingFlows.delete(state);
  return pending;
}

async function exchangeAuthorizationCode(
  pending: PendingFlow,
  code: string,
  clientId: string,
  secret: string,
): Promise<{ idToken: string; accessToken?: string }> {
  const discovery = await loadDiscovery();
  const credentials = Buffer.from(`${clientId}:${secret}`, "utf8").toString(
    "base64",
  );
  const tokenResponse = (await fetchJson(discovery.token_endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirectUri,
      client_id: clientId,
      code_verifier: pending.verifier,
    }),
  })) as { id_token?: unknown; access_token?: unknown };
  return {
    idToken:
      typeof tokenResponse.id_token === "string" ? tokenResponse.id_token : "",
    accessToken:
      typeof tokenResponse.access_token === "string" &&
      tokenResponse.access_token
        ? tokenResponse.access_token
        : undefined,
  };
}

function callbackSessionRedirect(
  req: Request,
  pending: PendingFlow,
  identity: OidcIdentity,
  tokens: { idToken: string; accessToken?: string },
): Response {
  const session = mintSession(
    identity,
    tokens.accessToken,
    idTokenExpSeconds(tokens.idToken),
  );
  return redirectResponse(pending.returnTo, [
    sessionCookie(req, session.token, session.maxAge),
    sessionCookie(req, "", 0, FLOW_COOKIE),
  ]);
}

export async function handleOidcCallback(req: Request): Promise<Response> {
  const gated = requireOidcCodeFlow(
    req,
    "OIDC callback is not available on this host",
  );
  if (gated) return gated;

  const query = readCallbackQuery(req);
  if (!query.ok) return query.response;

  const pending = consumePendingFlow(req, query.state);
  if (pending instanceof Response) return pending;

  const secret = readClientSecret();
  const clientId = oidcClientId();
  if (!secret || !clientId) {
    return textResponse(503, "OIDC client secret file is not configured");
  }

  try {
    const tokens = await exchangeAuthorizationCode(
      pending,
      query.code,
      clientId,
      secret,
    );
    const identity = await verifyOidcIdToken(tokens.idToken, pending.nonce);
    if (!identity) return textResponse(401, "OIDC identity token is invalid");
    return callbackSessionRedirect(req, pending, identity, tokens);
  } catch (error) {
    console.warn(
      "OIDC callback failed",
      error instanceof Error ? error.message : "unknown error",
    );
    return textResponse(502, "OIDC token exchange failed");
  }
}

export async function handleOidcLogout(req: Request): Promise<Response> {
  if (!hostAllowedForFlow(req)) {
    return textResponse(403, "OIDC logout is not available on this host");
  }
  const cookie = extractOidcCookie(req);
  if (cookie) oidcSessions.delete(cookie);
  const bearer = extractOidcBearer(req);
  if (bearer?.startsWith("ocx_oidc_")) oidcSessions.delete(bearer);

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
        return redirectResponse(endSession.toString(), clearCookies(req));
      }
    } catch {
      /* local cookie clear is enough */
    }
  }
  return redirectResponse(location, clearCookies(req));
}
