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
  safeOidcReturnTo,
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
const INTROSPECT =
  "https://auth.chefgroep.online/application/o/ocx/introspect/";

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
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    sub: "user-1",
    email: "operator@example.test",
    ...overrides,
  };
}

function discoveryDocument(includeIntrospection = false) {
  return {
    issuer: ISSUER,
    authorization_endpoint: AUTHORIZE,
    token_endpoint: TOKEN,
    jwks_uri: JWKS,
    end_session_endpoint: END_SESSION,
    ...(includeIntrospection ? { introspection_endpoint: INTROSPECT } : {}),
  };
}

function setCookies(response: Response): string[] {
  const typed = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  if (typeof typed.getSetCookie === "function") return typed.getSetCookie();
  const single = response.headers.get("Set-Cookie");
  return single ? [single] : [];
}

function cookiePair(response: Response, name: string): string | null {
  for (const cookie of setCookies(response)) {
    const [pair] = cookie.split(";");
    if (pair?.startsWith(`${name}=`)) return pair ?? null;
  }
  return null;
}

function cookieLine(response: Response, name: string): string | null {
  return (
    setCookies(response).find((cookie) => cookie.startsWith(`${name}=`)) ?? null
  );
}

function mockOidcNetwork(options?: {
  idToken?: string;
  accessToken?: string;
  tokenStatus?: number;
  introspectActive?: boolean;
}): void {
  setOidcFetchForTests(async (input) => {
    const url = String(input);
    if (url.includes(".well-known/openid-configuration")) {
      return Response.json(
        discoveryDocument(options?.introspectActive !== undefined),
      );
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
        ...(options?.accessToken ? { access_token: options.accessToken } : {}),
      });
    }
    if (url === INTROSPECT) {
      return Response.json({
        active: options?.introspectActive !== false,
        sub: "user-1",
        client_id: CLIENT_ID,
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
      new Request("http://127.0.0.1:10100/oauth/login?return_to=/usage", {
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
    const flow = cookieLine(response, "ocx_oidc_flow");
    expect(flow).toContain("HttpOnly");
    expect(flow).toContain("SameSite=Lax");
    expect(flow).toContain("Max-Age=600");
    expect(flow).not.toContain("Secure");
  });

  test("return_to accepts same-origin relative paths and rejects open redirects", () => {
    expect(safeOidcReturnTo("/usage")).toBe("/usage");
    expect(safeOidcReturnTo("/providers?tab=oauth")).toBe(
      "/providers?tab=oauth",
    );
    expect(safeOidcReturnTo("//evil.test")).toBe("/");
    expect(safeOidcReturnTo("https://evil.test/")).toBe("/");
    expect(safeOidcReturnTo("\\evil")).toBe("/");
    expect(safeOidcReturnTo(" /oops")).toBe("/");
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

  async function startLogin(returnTo = "/"): Promise<{
    state: string;
    nonce: string;
    flow: string;
  }> {
    const start = await handleOidcAuthorize(
      new Request(
        `http://127.0.0.1:10100/oauth/login?return_to=${encodeURIComponent(returnTo)}`,
        { headers: { Host: "127.0.0.1:10100" } },
      ),
    );
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.get("Location") ?? "");
    return {
      state: authorize.searchParams.get("state") ?? "",
      nonce: authorize.searchParams.get("nonce") ?? "",
      flow: cookiePair(start, "ocx_oidc_flow") ?? "",
    };
  }

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
          access_token: "access-one",
        });
      }
      return new Response("missing", { status: 404 });
    });

    const started = await startLogin("/usage");
    capturedNonce = started.nonce;

    const missingBinding = await handleOidcCallback(
      new Request(
        `http://127.0.0.1:10100/oauth/callback?code=one-time&state=${started.state}`,
        { headers: { Host: "127.0.0.1:10100" } },
      ),
    );
    expect(missingBinding.status).toBe(400);

    const wrongBinding = await handleOidcCallback(
      new Request(
        `http://127.0.0.1:10100/oauth/callback?code=one-time&state=${started.state}`,
        {
          headers: {
            Host: "127.0.0.1:10100",
            Cookie: "ocx_oidc_flow=not-the-binding",
          },
        },
      ),
    );
    expect(wrongBinding.status).toBe(400);

    const callback = await handleOidcCallback(
      new Request(
        `http://127.0.0.1:10100/oauth/callback?code=one-time&state=${started.state}`,
        {
          headers: {
            Host: "127.0.0.1:10100",
            Cookie: started.flow,
          },
        },
      ),
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe("/usage");
    expect(callback.headers.get("Location")).not.toContain("access-one");
    const sessionCookie = cookieLine(callback, "ocx_oidc") ?? "";
    expect(sessionCookie).toContain("ocx_oidc=");
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("SameSite=Lax");
    expect(sessionCookie).not.toContain("test-client-secret");
    expect(sessionCookie).not.toContain("access-one");
    expect(cookieLine(callback, "ocx_oidc_flow")).toContain("Max-Age=0");

    const identity = await verifyOidcRequest(
      new Request("http://127.0.0.1:10100/", {
        headers: {
          Host: "127.0.0.1:10100",
          Cookie: cookiePair(callback, "ocx_oidc") ?? "",
        },
      }),
    );
    expect(identity).toEqual({ email: "operator@example.test", sub: "user-1" });

    const replay = await handleOidcCallback(
      new Request(
        `http://127.0.0.1:10100/oauth/callback?code=one-time&state=${started.state}`,
        {
          headers: {
            Host: "127.0.0.1:10100",
            Cookie: started.flow,
          },
        },
      ),
    );
    expect(replay.status).toBe(400);
  });

  test("callback rejects forged issuer, audience, expiry, and nonce without minting a session", async () => {
    configureOidc(true);
    for (const payload of [
      validPayload({ nonce: "wrong-nonce" }),
      validPayload({ iss: "https://evil.test/application/o/ocx/" }),
      validPayload({ aud: "other-client" }),
      validPayload({ exp: Math.floor(Date.now() / 1000) - 30 }),
    ]) {
      resetOidcStateForTests();
      let capturedNonce = "";
      setOidcFetchForTests(async (input) => {
        const url = String(input);
        if (url.includes(".well-known/openid-configuration")) {
          return Response.json(discoveryDocument());
        }
        if (url === JWKS) return Response.json({ keys: [jwk] });
        if (url === TOKEN) {
          return Response.json({
            id_token: signJwt(
              payload.nonce === "wrong-nonce"
                ? payload
                : { ...payload, nonce: capturedNonce },
            ),
          });
        }
        return new Response("missing", { status: 404 });
      });
      const started = await startLogin();
      capturedNonce = started.nonce;
      const callback = await handleOidcCallback(
        new Request(
          `http://127.0.0.1:10100/oauth/callback?code=bad&state=${started.state}`,
          {
            headers: {
              Host: "127.0.0.1:10100",
              Cookie: started.flow,
            },
          },
        ),
      );
      expect(callback.status).toBe(401);
      expect(cookiePair(callback, "ocx_oidc")).toBeNull();
    }
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
    expect(cookieLine(logout, "ocx_oidc")).toContain("Max-Age=0");
    expect(cookieLine(logout, "ocx_oidc_flow")).toContain("Max-Age=0");
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

  test("logout and IdP introspection revoke dashboard access on the next request", async () => {
    configureOidc(true);
    let capturedNonce = "";
    let introspectActive = true;
    setOidcFetchForTests(async (input) => {
      const url = String(input);
      if (url.includes(".well-known/openid-configuration")) {
        return Response.json(discoveryDocument(true));
      }
      if (url === JWKS) return Response.json({ keys: [jwk] });
      if (url === TOKEN) {
        return Response.json({
          id_token: signJwt(validPayload({ nonce: capturedNonce })),
          access_token: "access-live",
        });
      }
      if (url === INTROSPECT) {
        return Response.json({
          active: introspectActive,
          sub: "user-1",
          client_id: CLIENT_ID,
        });
      }
      return new Response("missing", { status: 404 });
    });

    const started = await startLogin();
    capturedNonce = started.nonce;
    const callback = await handleOidcCallback(
      new Request(
        `http://127.0.0.1:10100/oauth/callback?code=one-time&state=${started.state}`,
        {
          headers: {
            Host: "127.0.0.1:10100",
            Cookie: started.flow,
          },
        },
      ),
    );
    const sessionPair = cookiePair(callback, "ocx_oidc") ?? "";
    const config = remoteConfig();
    const state = initializeManagementAuthState(config);
    const page = new Request("http://0.0.0.0:10100/", {
      headers: {
        Host: "ocx.chefgroep.online",
        "x-forwarded-proto": "https",
        Cookie: sessionPair,
      },
    });
    const session = await issueGuiSession(page, config, state);
    expect(session).not.toBeNull();

    const allowed = await requireManagementAuth(
      new Request("http://0.0.0.0:10100/api/usage", {
        headers: {
          Host: "ocx.chefgroep.online",
          Origin: "https://ocx.chefgroep.online",
          "x-forwarded-proto": "https",
          "x-opencodex-gui-origin": "https://ocx.chefgroep.online",
          Authorization: `Bearer ${session?.token}`,
          Cookie: sessionPair,
        },
      }),
      state,
      config,
    );
    expect(allowed).toBeNull();

    await handleOidcLogout(
      new Request("http://127.0.0.1:10100/oauth/logout", {
        headers: {
          Host: "127.0.0.1:10100",
          Cookie: sessionPair,
        },
      }),
    );
    const afterLogout = await requireManagementAuth(
      new Request("http://0.0.0.0:10100/api/usage", {
        headers: {
          Host: "ocx.chefgroep.online",
          Origin: "https://ocx.chefgroep.online",
          "x-forwarded-proto": "https",
          "x-opencodex-gui-origin": "https://ocx.chefgroep.online",
          Authorization: `Bearer ${session?.token}`,
        },
      }),
      state,
      config,
    );
    expect(afterLogout?.status).toBe(401);

    const startedAgain = await startLogin();
    capturedNonce = startedAgain.nonce;
    const second = await handleOidcCallback(
      new Request(
        `http://127.0.0.1:10100/oauth/callback?code=two&state=${startedAgain.state}`,
        {
          headers: {
            Host: "127.0.0.1:10100",
            Cookie: startedAgain.flow,
          },
        },
      ),
    );
    const secondPair = cookiePair(second, "ocx_oidc") ?? "";
    expect(
      await verifyOidcRequest(
        new Request("http://127.0.0.1:10100/", {
          headers: { Host: "127.0.0.1:10100", Cookie: secondPair },
        }),
      ),
    ).toEqual({ email: "operator@example.test", sub: "user-1" });
    introspectActive = false;
    expect(
      await verifyOidcRequest(
        new Request("http://127.0.0.1:10100/", {
          headers: { Host: "127.0.0.1:10100", Cookie: secondPair },
        }),
      ),
    ).toBeNull();
  });

  test("public dashboard without an OIDC session redirects to login; a session serves 200", async () => {
    configureOidc(true);
    mockOidcNetwork();
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const denied = await fetch(new URL("/", server.url), {
        redirect: "manual",
        headers: {
          Host: "ocx.chefgroep.online",
          "x-forwarded-proto": "https",
        },
      });
      expect(denied.status).toBe(302);
      expect(denied.headers.get("location")).toBe("/oauth/login?return_to=%2F");

      let capturedNonce = "";
      setOidcFetchForTests(async (input) => {
        const url = String(input);
        if (url.includes(".well-known/openid-configuration")) {
          return Response.json(discoveryDocument());
        }
        if (url === JWKS) return Response.json({ keys: [jwk] });
        if (url === TOKEN) {
          return Response.json({
            id_token: signJwt(validPayload({ nonce: capturedNonce })),
          });
        }
        return new Response("missing", { status: 404 });
      });
      const started = await startLogin();
      capturedNonce = started.nonce;
      const callback = await handleOidcCallback(
        new Request(
          `http://127.0.0.1:10100/oauth/callback?code=dash&state=${started.state}`,
          {
            headers: {
              Host: "127.0.0.1:10100",
              Cookie: started.flow,
            },
          },
        ),
      );
      const sessionPair = cookiePair(callback, "ocx_oidc") ?? "";
      const allowed = await fetch(new URL("/", server.url), {
        redirect: "manual",
        headers: {
          Host: "ocx.chefgroep.online",
          "x-forwarded-proto": "https",
          Cookie: sessionPair,
        },
      });
      expect(allowed.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("an OIDC browser session never authorizes the data plane or model proxy", async () => {
    configureOidc(true);
    let capturedNonce = "";
    setOidcFetchForTests(async (input) => {
      const url = String(input);
      if (url.includes(".well-known/openid-configuration")) {
        return Response.json(discoveryDocument());
      }
      if (url === JWKS) return Response.json({ keys: [jwk] });
      if (url === TOKEN) {
        return Response.json({
          id_token: signJwt(validPayload({ nonce: capturedNonce })),
        });
      }
      return new Response("missing", { status: 404 });
    });
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const started = await startLogin();
      capturedNonce = started.nonce;
      const callback = await handleOidcCallback(
        new Request(
          `http://127.0.0.1:10100/oauth/callback?code=plane&state=${started.state}`,
          {
            headers: {
              Host: "127.0.0.1:10100",
              Cookie: started.flow,
            },
          },
        ),
      );
      const sessionPair = cookiePair(callback, "ocx_oidc") ?? "";
      const idToken = signJwt(validPayload());

      const cookieModels = await fetch(new URL("/v1/models", server.url), {
        headers: { Cookie: sessionPair },
      });
      expect(cookieModels.status).toBe(401);

      const sessionBearer = await fetch(new URL("/v1/models", server.url), {
        headers: {
          Authorization: `Bearer ${sessionPair.replace("ocx_oidc=", "")}`,
        },
      });
      expect(sessionBearer.status).toBe(401);

      const idTokenModels = await fetch(new URL("/v1/models", server.url), {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      expect(idTokenModels.status).toBe(401);

      const chat = await fetch(new URL("/v1/chat/completions", server.url), {
        method: "POST",
        headers: {
          Cookie: sessionPair,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-test", messages: [] }),
      });
      expect(chat.status).toBe(401);

      const withDataKey = await fetch(new URL("/v1/models", server.url), {
        headers: { Authorization: "Bearer data-secret" },
      });
      expect(withDataKey.status).toBe(200);

      const healthz = await fetch(new URL("/healthz", server.url));
      expect(healthz.status).toBe(200);
      expect(await healthz.json()).toMatchObject({
        status: "ok",
        service: "opencodex",
      });
    } finally {
      await server.stop(true);
    }
  });

  test("OIDC login is refused on an untrusted host", async () => {
    configureOidc(true);
    mockOidcNetwork();
    const response = await handleOidcAuthorize(
      new Request("http://attacker.test/oauth/login", {
        headers: { Host: "attacker.test" },
      }),
    );
    expect(response.status).toBe(403);
  });
});
