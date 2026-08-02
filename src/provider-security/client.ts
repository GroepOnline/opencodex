/**
 * ChefVault provider-security HTTP client (PSP-008).
 *
 * Talks to the secret authority at CHEF_PROVIDER_SECURITY_URL (default :8323).
 * Protected routes require Authorization: Bearer from CHEF_PROVIDER_SECURITY_TOKEN.
 * Workload identity headers are assertions only (must match the token binding).
 */
import {
  type ChefVaultRenewRequest,
  type ChefVaultRenewResponse,
  type ChefVaultResolveRequest,
  type ChefVaultResolveResponse,
  ProviderSecurityError,
  type ProviderSecurityClientConfig,
  type WorkloadIdentity,
} from "./types";

export const DEFAULT_PROVIDER_SECURITY_URL = "http://127.0.0.1:8323";

const WORKLOAD_HEADER_WORKLOAD = "x-chef-workload-id";
const WORKLOAD_HEADER_HOST = "x-chef-host-id";
const WORKLOAD_HEADER_ACTOR = "x-chef-actor";

export function resolveProviderSecurityUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.CHEF_PROVIDER_SECURITY_URL?.trim();
  return raw || DEFAULT_PROVIDER_SECURITY_URL;
}

export function resolveProviderSecurityToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.CHEF_PROVIDER_SECURITY_TOKEN?.trim();
  return raw || undefined;
}

export function resolveWorkloadIdentity(env: NodeJS.ProcessEnv = process.env): WorkloadIdentity {
  return {
    workloadId: env.CHEF_WORKLOAD_ID?.trim() || "opencodex",
    hostId: env.CHEF_HOST_ID?.trim() || env.HOSTNAME?.trim() || "local",
    actor: env.CHEF_ACTOR?.trim() || "opencodex",
  };
}

function workloadHeaders(workload: WorkloadIdentity): Record<string, string> {
  return {
    [WORKLOAD_HEADER_WORKLOAD]: workload.workloadId,
    [WORKLOAD_HEADER_HOST]: workload.hostId,
    [WORKLOAD_HEADER_ACTOR]: workload.actor,
  };
}

function mapAuthorityError(status: number, body: unknown): ProviderSecurityError {
  const record = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const code = typeof record.code === "string" ? record.code : undefined;
  const message = typeof record.message === "string"
    ? record.message
    : typeof record.error === "string"
      ? record.error
      : `ChefVault provider-security returned HTTP ${status}`;

  if (code === "stale_fencing_token") {
    return new ProviderSecurityError("stale_fencing_token", message);
  }
  if (status === 401 || code === "auth_required" || code === "auth_invalid") {
    return new ProviderSecurityError(
      code === "auth_invalid" ? "auth_invalid" : "auth_required",
      message,
    );
  }
  if (
    status === 403
    || code === "identity_assertion_mismatch"
    || code === "admin_required"
    || code === "workload_credential_required"
  ) {
    return new ProviderSecurityError(
      code === "identity_assertion_mismatch" ? "identity_assertion_mismatch" : "auth_forbidden",
      message,
    );
  }
  if (code === "auth_not_configured") {
    return new ProviderSecurityError("auth_not_configured", message);
  }
  if (status === 404 || code === "ref_not_found") {
    return new ProviderSecurityError("ref_not_found", message);
  }
  if (status === 400 || code === "ref_invalid") {
    return new ProviderSecurityError("ref_invalid", message);
  }
  if (status === 410 || code === "revoked") {
    return new ProviderSecurityError("revoked", message);
  }
  // An authority that answers 5xx is up but cannot serve; that is an outage, not a rejected
  // credential, and only outages are allowed to trip degraded mode.
  if (status >= 500) {
    return new ProviderSecurityError("authority_unavailable", message);
  }
  return new ProviderSecurityError("authority_error", message);
}

function parseLeaseFields(body: unknown, kind: "resolve" | "renew"): {
  record: Record<string, unknown>;
  lease: ChefVaultRenewResponse;
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ProviderSecurityError("authority_error", `${kind} response was not an object`);
  }
  const record = body as Record<string, unknown>;
  const leaseId = typeof record.leaseId === "string" ? record.leaseId : "";
  const secret = typeof record.secret === "string" ? record.secret : "";
  const expiresAt = typeof record.expiresAt === "number" ? record.expiresAt : Number(record.expiresAt);
  const fencingToken = typeof record.fencingToken === "number" ? record.fencingToken : Number(record.fencingToken);
  if (!leaseId || !secret || !Number.isFinite(expiresAt) || !Number.isFinite(fencingToken)) {
    throw new ProviderSecurityError("authority_error", `${kind} response missing required lease fields`);
  }
  return { record, lease: { leaseId, secret, expiresAt, fencingToken } };
}

function parseResolveResponse(body: unknown): ChefVaultResolveResponse {
  const { record, lease } = parseLeaseFields(body, "resolve");
  const slotHint = record.slotHint;
  return {
    ...lease,
    ...(slotHint === "active" || slotHint === "next" || slotHint === "retiring"
      ? { slotHint }
      : {}),
  };
}

function parseRenewResponse(body: unknown): ChefVaultRenewResponse {
  return parseLeaseFields(body, "renew").lease;
}

export class ProviderSecurityClient {
  readonly baseUrl: string;
  readonly workload: WorkloadIdentity;
  readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(config: ProviderSecurityClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.workload = config.workload;
    this.token = config.token?.trim() || undefined;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 8_000;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): ProviderSecurityClient {
    return new ProviderSecurityClient({
      baseUrl: resolveProviderSecurityUrl(env),
      workload: resolveWorkloadIdentity(env),
      token: resolveProviderSecurityToken(env),
    });
  }

  private requireToken(): string {
    if (!this.token) {
      throw new ProviderSecurityError(
        "auth_required",
        "CHEF_PROVIDER_SECURITY_TOKEN is required for ChefVault credential calls",
      );
    }
    return this.token;
  }

  private async request(
    path: string,
    init: RequestInit,
    opts: { auth: boolean },
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
      ...workloadHeaders(this.workload),
      ...(init.headers as Record<string, string> | undefined ?? {}),
    };
    // Resolve the token before arming the abort timer: requireToken() throws for
    // unauthenticated calls, and a timer armed before that throw would leak and keep a
    // short-lived process (e.g. the doctor CLI) alive until it fires.
    if (opts.auth) {
      headers.authorization = `Bearer ${this.requireToken()}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers,
      });
      // Read the body while the timeout is still armed: a response that stalls mid-body would
      // otherwise hang a credential call for as long as the authority keeps the socket open.
      const body = await response.json().catch(() => null);
      return { ok: response.ok, status: response.status, body };
    } catch (error) {
      if (error instanceof ProviderSecurityError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new ProviderSecurityError("network_error", "ChefVault provider-security request timed out");
      }
      throw new ProviderSecurityError(
        "authority_unavailable",
        error instanceof Error ? error.message : "ChefVault provider-security is unreachable",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Unauthenticated liveness probe. */
  async healthz(): Promise<{ ok: boolean; message: string }> {
    try {
      const { ok, status } = await this.request("/healthz", { method: "GET" }, { auth: false });
      if (!ok) {
        return { ok: false, message: `HTTP ${status}` };
      }
      return { ok: true, message: "ok" };
    } catch (error) {
      if (error instanceof ProviderSecurityError) {
        return { ok: false, message: error.message };
      }
      return { ok: false, message: "unreachable" };
    }
  }

  /**
   * Authenticated readiness: Bearer accepted on a protected route.
   * Uses GET /provider-security/status (redacted; no secrets).
   */
  async authenticatedReady(): Promise<{ ok: boolean; message: string }> {
    try {
      const { ok, status, body } = await this.request("/provider-security/status", { method: "GET" }, { auth: true });
      if (ok) {
        return { ok: true, message: "authenticated" };
      }
      const mapped = mapAuthorityError(status, body);
      return { ok: false, message: `${mapped.code}: ${mapped.message}` };
    } catch (error) {
      if (error instanceof ProviderSecurityError) {
        return { ok: false, message: `${error.code}: ${error.message}` };
      }
      return { ok: false, message: "unreachable" };
    }
  }

  async resolveLease(input: ChefVaultResolveRequest): Promise<ChefVaultResolveResponse> {
    const { ok, status, body } = await this.request("/v1/credentials/resolve", {
      method: "POST",
      body: JSON.stringify(input),
    }, { auth: true });
    if (!ok) {
      throw mapAuthorityError(status, body);
    }
    return parseResolveResponse(body);
  }

  async renewLease(input: ChefVaultRenewRequest): Promise<ChefVaultRenewResponse> {
    const { ok, status, body } = await this.request("/v1/credentials/renew", {
      method: "POST",
      body: JSON.stringify(input),
    }, { auth: true });
    if (!ok) {
      throw mapAuthorityError(status, body);
    }
    return parseRenewResponse(body);
  }
}
