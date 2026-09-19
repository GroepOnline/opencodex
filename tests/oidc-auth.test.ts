import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import {
  handleOidcAuthorize,
  handleOidcCallback,
  handleOidcLogout,
  isOidcTrustedHost,
  oidcCodeFlowConfigured,
  oidcConfigured,
  resetOidcStateForTests,
  setOidcFetchForTests,
  verifyOidcIdToken,
  verifyOidcRequest,
} from "../src/server/oidc-auth";
import {
  initializeManagementAuthState,
  issueGuiSession,
  requireManagementAuth,
} from "../src/server/management-auth";
import type { OcxConfig } from "../src/types";

const ISSUER = "https://auth.chefgroep.online/application/o/ocx/";
const CLIENT_ID = "chefgroep-ocx-oidc";
const AUTHORIZE = "https://auth.chefgroep.online/application/o/authorize/";
const TOKEN = "https://auth.chefgroep.online/application/o/token/";
const JWKS = "https://auth.chefgroep.online/application/o/ocx/jwks/";
const END_SESSION =
  "https://auth.chefgroep.online/application/o/ocx/end-session/";

const previousHome = process.env.OPENCODEX_HOME;
const previousAdmin = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
const previousData = process.env.OPENCODEX_API_AUTH_TOKEN;
const oidcEnvKeys = [
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET_FILE",
  "OIDC_REDIRECT_URI",
  "OIDC_ALLOWED_HOSTS",
] as const;
const previousOidc = Object.fromEntries(
  oidcEnvKeys.map((key) => [key, process.env[key]]),
);

let testHome = "";
let secretDir = "";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "jwk" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const jwk = { ...publicKey, kid: "test-kid", use: "sig", alg: "RS256" };

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signJwt(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", kid: "test-kid" },
): string {
  const encoded = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(encoded);
  signer.end();
  return `${encoded}.${signer.sign(privateKey).toString("base64url")}`;
}

function validPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 300,
    sub: "user-1",
    email: "operator@example.test",
    ...overrides,
  };
}

function discoveryDocument() {
  return {
    issuer: ISSUER,
    authorization_endpoint: AUTHORIZE,
    token_endpoint: TOKEN,
    jwks_uri: JWKS,
    end_session_endpoint: END_SESSION,
  };
}

function mockOidcNetwork(options?: {
  idToken?: string;
  tokenStatus?: number;
}): void {
  setOidcFetchForTests(async (input) => {
    const url = String(input);
    if (url.includes(".well-known/openid-configuration")) {
      return Response.json(discoveryDocument());
    }
    if (url === JWKS) {
      return Response.json({ keys: [jwk] });
    }
    if (url === TOKEN) {
      if (options?.tokenStatus && options.tokenStatus !== 200) {
        return new Response("nope", { status: options.tokenStatus });
      }
      return Response.json({
        id_token:
          options?.idToken ?? signJwt(validPayload({ nonce: "will-replace" })),
      });
    }
    return new Response("missing", { status: 404 });
  });
}

function remoteConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "0.0.0.0",
    defaultProvider: "test",
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        disabled: true,
        models: ["gpt-test"],
      },
    },
  };
}

function configureOidc(secret = true): void {
  process.env.OIDC_ISSUER = ISSUER;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.OIDC_REDIRECT_URI = "http://127.0.0.1:10100/oauth/callback";
  process.env.OIDC_ALLOWED_HOSTS = "ocx.chefgroep.online";
  if (secret) {
    const path = join(secretDir, "oidc-client-secret");
    writeFileSync(path, "test-client-secret\n", { mode: 0o600 });
    process.env.OIDC_CLIENT_SECRET_FILE = path;
  } else {
    delete process.env.OIDC_CLIENT_SECRET_FILE;
  }
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-oidc-"));
  secretDir = mkdtempSync(join(tmpdir(), "ocx-oidc-secret-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "admin-secret";
  process.env.OPENCODEX_API_AUTH_TOKEN = "data-secret";
  resetOidcStateForTests();
});

afterEach(() => {
  resetOidcStateForTests();
  for (const key of oidcEnvKeys) {
    const previous = previousOidc[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  delete process.env.CF_ACCESS_TEAM_DOMAIN;
  delete process.env.CF_ACCESS_AUD;
  delete process.env.CF_ACCESS_ALLOWED_HOSTS;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousAdmin === undefined)
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdmin;
  if (previousData === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousData;
  rmSync(testHome, { recursive: true, force: true });
  rmSync(secretDir, { recursive: true, force: true });
});

describe("Authentik OIDC consumer", () => {
  test("token verify needs issuer + client_id; code flow also needs secret file", () => {
    expect(oidcConfigured()).toBe(false);
    expect(oidcCodeFlowConfigured()).toBe(false);
    process.env.OIDC_ISSUER = ISSUER;
    process.env.OIDC_CLIENT_ID = CLIENT_ID;
    expect(oidcConfigured()).toBe(true);
    expect(oidcCodeFlowConfigured()).toBe(false);
    configureOidc(true);
    expect(oidcCodeFlowConfigured()).toBe(true);
  });

  test("trusted hosts come from redirect URI and OIDC_ALLOWED_HOSTS", () => {
    configureOidc(false);
    expect(isOidcTrustedHost("127.0.0.1")).toBe(true);
    expect(isOidcTrustedHost("localhost")).toBe(true);
    expect(isOidcTrustedHost("ocx.chefgroep.online")).toBe(true);
    expect(isOidcTrustedHost("attacker.test")).toBe(false);
  });

  test("verifies a live-shaped Authentik ID token and rejects broken claims", async () => {
    configureOidc(false);
    mockOidcNetwork();
    const token = signJwt(validPayload());
    await expect(verifyOidcIdToken(token)).resolves.toEqual({
      email: "operator@example.test",
      sub: "user-1",
    });
    await expect(
      verifyOidcIdToken(signJwt(validPayload({ iss: "https://evil.test/" }))),
    ).resolves.toBeNull();
    await expect(
      verifyOidcIdToken(signJwt(validPayload({ aud: "other-client" }))),
    ).resolves.toBeNull();
    await expect(
      verifyOidcIdToken(
        signJwt(validPayload({ exp: Math.floor(Date.now() / 1000) - 10 })),
      ),
    ).resolves.toBeNull();
    await expect(
      verifyOidcIdToken(
        signJwt(
          validPayload({ email: undefined, preferred_username: undefined }),
        ),
      ),
    ).resolves.toBeNull();
  });

  test("GET /oauth/login redirects to Authentik authorize with PKCE", async () => {
    configureOidc(true);
    mockOidcNetwork();
    const response = await handleOidcAuthorize(
      new Request("http://127.0.0.1:10100/oauth/login", {
        headers: { Host: "127.0.0.1:10100" },
      }),
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin + location.pathname).toBe(
      AUTHORIZE.replace(/\/$/, "") + "/",
    );
    expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:10100/oauth/callback",
    );
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toBeTruthy();
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("nonce")).toBeTruthy();
    expect(location.searchParams.get("scope")).toContain("openid");
  });

  test("GET /oauth/login without a secret file fails closed", async () => {
    configureOidc(false);
    const response = await handleOidcAuthorize(
      new Request("http://127.0.0.1:10100/oauth/login", {
        headers: { Host: "127.0.0.1:10100" },
      }),
    );
    expect(response.status).toBe(503);
  });

  test("GET /oauth/callback exchanges the code, sets a session cookie, and rejects replayed state", async () => {
    configureOidc(true);
    let capturedNonce = "";
    setOidcFetchForTests(async (input, init) => {
      const url = String(input);
      if (url.includes(".well-known/openid-configuration")) {
        return Response.json(discoveryDocument());
      }
      if (url === JWKS) return Response.json({ keys: [jwk] });
      if (url === TOKEN) {
        expect(
          init?.headers && new Headers(init.headers).get("authorization"),
        ).toMatch(/^Basic /);
        expect(String(init?.body)).toContain("grant_type=authorization_code");
        expect(String(init?.body)).not.toContain("test-client-secret");
        return Response.json({
          id_token: signJwt(validPayload({ nonce: capturedNonce })),
        });
      }
      return new Response("missing", { status: 404 });
    });

    const start = await handleOidcAuthorize(
      new Request("http://127.0.0.1:10100/oauth/login", {
        headers: { Host: "127.0.0.1:10100" },
      }),
    );
    const authorize = new URL(start.headers.get("Location") ?? "");
    capturedNonce = authorize.searchParams.get("nonce") ?? "";
    const state = authorize.searchParams.get("state") ?? "";

    const callback = await handleOidcCallback(
      new Request(
        `http://127.0.0.1:10100/oauth/callback?code=one-time&state=${state}`,
        { headers: { Host: "127.0.0.1:10100" } },
      ),
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe("/");
    const cookie = callback.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("ocx_oidc=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toContain("test-client-secret");

    const identity = await verifyOidcRequest(
      new Request("http://127.0.0.1:10100/", {
        headers: {
          Host: "127.0.0.1:10100",
          Cookie: cookie.split(";")[0] ?? "",
        },
      }),
    );
    expect(identity).toEqual({ email: "operator@example.test", sub: "user-1" });

    const replay = await handleOidcCallback(
      new Request(
        `http://127.0.0.1:10100/oauth/callback?code=one-time&state=${state}`,
        { headers: { Host: "127.0.0.1:10100" } },
      ),
    );
    expect(replay.status).toBe(400);
  });

  test("GET /oauth/logout clears the session cookie and can hand off to Authentik", async () => {
    configureOidc(true);
    mockOidcNetwork();
    const logout = await handleOidcLogout(
      new Request("http://127.0.0.1:10100/oauth/logout", {
        headers: { Host: "127.0.0.1:10100" },
      }),
    );
    expect(logout.status).toBe(302);
    expect(logout.headers.get("Location")).toContain(END_SESSION);
    expect(logout.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  test("Authentik OIDC authorizes public GUI management without an admin token", async () => {
    configureOidc(false);
    mockOidcNetwork();
    const token = signJwt(validPayload());
    const config = remoteConfig();
    const state = initializeManagementAuthState(config);
    const denied = new Request("http://0.0.0.0:10100/api/usage", {
      headers: {
        Host: "ocx.chefgroep.online",
        Origin: "https://ocx.chefgroep.online",
        "x-forwarded-proto": "https",
        Authorization: `Bearer ${token}`,
      },
    });
    expect(await requireManagementAuth(denied, state, config)).toBeNull();

    const untrusted = new Request("http://0.0.0.0:10100/api/usage", {
      headers: {
        Host: "attacker.test",
        Origin: "https://attacker.test",
        Authorization: `Bearer ${token}`,
      },
    });
    expect(
      (await requireManagementAuth(untrusted, state, config))?.status,
    ).toBe(401);

    const session = await issueGuiSession(
      new Request("http://0.0.0.0:10100/", {
        headers: {
          Host: "ocx.chefgroep.online",
          "x-forwarded-proto": "https",
          Authorization: `Bearer ${token}`,
        },
      }),
      config,
      state,
    );
    expect(session).not.toBeNull();
    expect(session?.origin).toBe("https://ocx.chefgroep.online");
  });

  test("live server keeps /healthz open and serves the authorize flow on :10100", async () => {
    configureOidc(true);
    mockOidcNetwork();
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const health = await fetch(new URL("/healthz", server.url));
      expect(health.status).toBe(200);
      const body = (await health.json()) as { service: string; port: number };
      expect(body.service).toBe("opencodex");
      expect(typeof body.port).toBe("number");

      const loginUrl = new URL("/oauth/login", server.url);
      const login = await fetch(loginUrl, {
        redirect: "manual",
        headers: { Host: `127.0.0.1:${loginUrl.port}` },
      });
      expect(login.status).toBe(302);
      const location = login.headers.get("location") ?? "";
      expect(location.startsWith(AUTHORIZE)).toBe(true);
      expect(location).toContain(`client_id=${CLIENT_ID}`);

      const token = signJwt(validPayload());
      const dataPlane = await fetch(new URL("/v1/models", server.url), {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(dataPlane.status).toBe(401);
    } finally {
      await server.stop(true);
    }
  });
});
