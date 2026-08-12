import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { adminApiTokenFilePath } from "../lib/admin-secrets";
import { rateLimitFingerprinter, type RateLimitPrincipal } from "../ratelimit";
import { hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";
import type { OcxConfig } from "../types";
import {
  isAllowedManagementOrigin,
  isApiAuthRequired,
  isDataPlaneAdmissionSecret,
  isLoopbackHostname,
  managementRequestOrigin,
  parseHttpHost,
} from "./auth-cors";
import {
  cfAccessConfigured,
  isCfAccessTrustedHost,
  verifyCfAccessRequest,
} from "./cf-access-auth";

const GUI_SESSION_TTL_MS = 5 * 60_000;
const GUI_SESSION_LIMIT = 128;

interface GuiSessionRecord {
  csrfToken: string;
  origin: string;
  expiresAt: number;
}

export interface GuiSessionBootstrap extends GuiSessionRecord {
  token: string;
}

export type ManagementAuthState =
  | {
    available: true;
    token: string;
    source: "environment" | "file";
    sessions: Map<string, GuiSessionRecord>;
  }
  | { available: false; reason: string };

function fail(reason: string): ManagementAuthState {
  return { available: false, reason };
}

function assertSafeDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("management token directory is not a regular directory");
  chmodSync(path, 0o700);
  const hardened = hardenSecretDir(path, { required: true });
  if (!hardened.ok) throw new Error("management token directory ACL hardening did not complete");
}

function readExistingToken(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512) {
    throw new Error("management token path is not a regular secret file");
  }
  chmodSync(path, 0o600);
  const hardened = hardenSecretPath(path, { required: true });
  if (!hardened.ok) throw new Error("management token file ACL hardening did not complete");
  const token = readFileSync(path, "utf8").trim();
  if (!/^ocx_admin_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("management token file is invalid");
  return token;
}

function removeBestEffort(path: string): void {
  try { unlinkSync(path); } catch { /* fail-closed state is preserved by the caller */ }
}

function createTokenFile(path: string): string {
  const directory = dirname(path);
  const token = `ocx_admin_${randomBytes(32).toString("base64url")}`;
  const temporary = join(directory, `.${randomUUID()}.admin-token.tmp`);
  let linked = false;
  let fd: number | null = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${token}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    chmodSync(temporary, 0o600);
    const temporaryHardened = hardenSecretPath(temporary, { required: true });
    if (!temporaryHardened.ok) throw new Error("management token temporary ACL hardening did not complete");
    try {
      linkSync(temporary, path);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return readExistingToken(path);
      throw error;
    }
    const finalHardened = hardenSecretPath(path, { required: true });
    if (!finalHardened.ok) throw new Error("management token file ACL hardening did not complete");
    return token;
  } catch (error) {
    if (linked) removeBestEffort(path);
    throw error;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    removeBestEffort(temporary);
  }
}

function ready(token: string, source: "environment" | "file", config: OcxConfig): ManagementAuthState {
  if (isDataPlaneAdmissionSecret(token, config)) {
    return fail("management credential conflicts with a data-plane credential");
  }
  return { available: true, token, source, sessions: new Map() };
}

export function initializeManagementAuthState(config: OcxConfig): ManagementAuthState {
  const environmentToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN?.trim();
  if (environmentToken) {
    return ready(environmentToken, "environment", config);
  }
  try {
    const path = adminApiTokenFilePath();
    assertSafeDirectory(dirname(path));
    let token: string;
    try {
      token = readExistingToken(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      token = createTokenFile(path);
    }
    return ready(token, "file", config);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "management token initialization failed");
  }
}

function equalSecret(actual: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(actual);
  const right = encoder.encode(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function removeExpiredSessions(state: Extract<ManagementAuthState, { available: true }>, now = Date.now()): void {
  for (const [token, session] of state.sessions) {
    if (session.expiresAt <= now) state.sessions.delete(token);
  }
}

function randomSessionSecret(prefix: "ocx_session_"): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export async function issueGuiSession(
  req: Request,
  config: OcxConfig,
  state: ManagementAuthState,
): Promise<GuiSessionBootstrap | null> {
  if (!state.available || req.method !== "GET" || !isAllowedManagementOrigin(req, config)) return null;
  const host = parseHttpHost(req.headers.get("Host"));
  if (!host) return null;

  // Loopback GUI session (laptop tunnel / local bind) — unchanged trust model.
  const loopbackSession = !isApiAuthRequired(config) && isLoopbackHostname(host.hostname);
  // Public ocx.chefgroep.online: mint only when Cloudflare Access JWT is valid.
  let accessSession = false;
  if (!loopbackSession && cfAccessConfigured() && isCfAccessTrustedHost(host.hostname)) {
    accessSession = !!(await verifyCfAccessRequest(req));
  }
  if (!loopbackSession && !accessSession) return null;

  const origin = managementRequestOrigin(req, config);
  if (!origin) return null;
  const now = Date.now();
  removeExpiredSessions(state, now);
  while (state.sessions.size >= GUI_SESSION_LIMIT) {
    const oldest = state.sessions.keys().next().value as string | undefined;
    if (!oldest) break;
    state.sessions.delete(oldest);
  }
  const token = randomSessionSecret("ocx_session_");
  const session: GuiSessionRecord = {
    csrfToken: randomBytes(32).toString("base64url"),
    origin,
    expiresAt: now + GUI_SESSION_TTL_MS,
  };
  state.sessions.set(token, session);
  return { token, ...session };
}

/**
 * Resolve the opaque rate-limit principal for a management request without exposing the raw
 * credential outside this auth boundary. Only a VALIDATED management admin token or a live GUI
 * session token earns its own bucket; anything else falls back to the trusted socket address
 * or the shared anonymous bucket, so an unvalidated presented key never mints a fresh bucket.
 */
export function resolveManagementRateLimitPrincipal(
  req: Request,
  state: ManagementAuthState,
  remoteAddress: string | null | undefined,
): RateLimitPrincipal {
  if (state.available) {
    const actual = req.headers.get("x-opencodex-api-key")?.trim()
      || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
    if (actual) {
      if (equalSecret(actual, state.token)) return rateLimitFingerprinter.management(state.token);
      removeExpiredSessions(state);
      if (state.sessions.has(actual)) return rateLimitFingerprinter.management(actual);
    }
  }
  const address = remoteAddress?.trim();
  if (address) return rateLimitFingerprinter.remoteAddress(address);
  return rateLimitFingerprinter.anonymous();
}

export async function requireManagementAuth(
  req: Request,
  state: ManagementAuthState,
  config?: OcxConfig,
): Promise<Response | null> {
  if (!state.available) {
    return Response.json({ error: "management API unavailable" }, { status: 503 });
  }
  const actual = req.headers.get("x-opencodex-api-key")?.trim()
    || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (actual && equalSecret(actual, state.token)) return null;
  if (actual && config) {
    removeExpiredSessions(state);
    const session = state.sessions.get(actual);
    if (session) {
      const requestOrigin = managementRequestOrigin(req, config);
      const claimedOrigin = req.headers.get("x-opencodex-gui-origin");
      const browserOrigin = req.headers.get("Origin");
      const sameOrigin = requestOrigin === session.origin
        && claimedOrigin === session.origin
        && (!browserOrigin || browserOrigin === session.origin);
      const safeMethod = req.method === "GET" || req.method === "HEAD";
      const csrf = req.headers.get("x-opencodex-csrf-token")?.trim();
      if (sameOrigin && (safeMethod || (browserOrigin === session.origin && !!csrf && equalSecret(csrf, session.csrfToken)))) {
        return null;
      }
    }
  }
  // Human GUI behind Cloudflare Access: valid Access JWT replaces admin prompt.
  // Tailscale/direct hits without JWT still require admin token or session.
  if (config && cfAccessConfigured()) {
    const host = parseHttpHost(req.headers.get("Host"));
    if (host && isCfAccessTrustedHost(host.hostname) && isAllowedManagementOrigin(req, config)) {
      if (await verifyCfAccessRequest(req)) return null;
    }
  }
  return Response.json({ error: "opencodex admin token required" }, { status: 401 });
}
