import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getValidAccessTokenForAccount, OAUTH_PROVIDERS } from "../src/oauth";
import { AnthropicTokenError, refreshAnthropicToken } from "../src/oauth/anthropic";
import { OAuthCallbackFlow, validateManualCallbackInput } from "../src/oauth/callback-server";
import { refreshChatGPTToken } from "../src/oauth/chatgpt";
import { oauthErrorDetail, readBoundedOAuthErrorBody } from "../src/oauth/http-errors";
import { getAccountCredential, getAccountSet, saveCredential } from "../src/oauth/store";
import {
  expiryWithSkew,
  OAuthTokenResponseError,
  optionalRefreshToken,
  requireAccessToken,
  requireExpiresInSeconds,
} from "../src/oauth/token-response";
import type { OAuthController, OAuthCredentials } from "../src/oauth/types";

const origFetch = globalThis.fetch;
const origHome = process.env.HOME;
const origOcxHome = process.env.OPENCODEX_HOME;
const origKimiRefresh = OAUTH_PROVIDERS.kimi!.refresh;
let tmp: string;

beforeEach(() => {
  tmp = join(tmpdir(), `oauth-hardening-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
  process.env.HOME = tmp;
  process.env.OPENCODEX_HOME = join(tmp, "ocx");
});

afterEach(() => {
  globalThis.fetch = origFetch;
  OAUTH_PROVIDERS.kimi!.refresh = origKimiRefresh;
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = origOcxHome;
  rmSync(tmp, { recursive: true, force: true });
});

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
}

// A long token-alphabet run (no provider prefix) so the redaction regex fires while the
// repository privacy scan's `sk-`/`ghp_`/`eyJ` token-looking pattern does not flag this fixture.
const LONG_SECRET = "oaat01" + "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_AbCdEfGhIjKl";

describe("oauthErrorDetail", () => {
  test("surfaces RFC 6749 error and description", () => {
    expect(oauthErrorDetail(JSON.stringify({ error: "invalid_grant", error_description: "Refresh token revoked" }))).toBe(
      "invalid_grant: Refresh token revoked",
    );
  });

  test("understands the nested error shape", () => {
    expect(oauthErrorDetail(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad code" } }))).toBe(
      "invalid_request_error: bad code",
    );
  });

  test("retains nested terminal error codes for refresh-token reuse detection", () => {
    expect(oauthErrorDetail(JSON.stringify({
      error: { type: "invalid_grant", code: "refresh_token_reused", message: "invalid refresh token" },
    }))).toContain("refresh_token_reused");
  });

  test("bounds an upstream response body before decoding", async () => {
    const body = new Response("x".repeat(32_768));
    expect((await readBoundedOAuthErrorBody(body)).length).toBe(8192);
    expect(body.bodyUsed).toBe(true);
  });

  test("redacts token-shaped runs reflected in an error description", () => {
    const detail = oauthErrorDetail(JSON.stringify({ error: "invalid_grant", error_description: `bad token ${LONG_SECRET}` }));
    expect(detail).not.toContain(LONG_SECRET);
    expect(detail).not.toContain("AbCdEfGhIjKlMnOpQrStUvWx");
    expect(detail).toContain("[redacted]");
  });

  test("caps each field and strips control characters", () => {
    const detail = oauthErrorDetail(JSON.stringify({ error: "x", error_description: `a\nb\u0000${"word ".repeat(200)}` }));
    expect(detail.length).toBeLessThan(260);
    // eslint-disable-next-line no-control-regex -- asserting control chars are stripped
    expect(detail).not.toMatch(/[\u0000-\u001f]/);
  });

  test("never returns a raw HTML or non-object body", () => {
    expect(oauthErrorDetail("<html><body>502 Bad Gateway</body></html>")).toBe("");
    expect(oauthErrorDetail("[1,2,3]")).toBe("");
    expect(oauthErrorDetail("null")).toBe("");
    expect(oauthErrorDetail("")).toBe("");
  });
});

describe("token response validation", () => {
  test("requireAccessToken rejects missing, empty and non-string values", () => {
    for (const bad of [undefined, null, "", "   ", 42, {}]) {
      expect(() => requireAccessToken("Test", bad)).toThrow(OAuthTokenResponseError);
    }
    expect(requireAccessToken("Test", "tok")).toBe("tok");
  });

  test("requireExpiresInSeconds rejects NaN, non-positive and non-numeric values", () => {
    for (const bad of ["abc", "", 0, -5, Number.NaN, Number.POSITIVE_INFINITY, {}, true]) {
      expect(() => requireExpiresInSeconds("Test", bad)).toThrow(OAuthTokenResponseError);
    }
    expect(requireExpiresInSeconds("Test", 3600)).toBe(3600);
    expect(requireExpiresInSeconds("Test", "3600")).toBe(3600);
  });

  test("requireExpiresInSeconds applies a fallback only when the field is absent", () => {
    expect(requireExpiresInSeconds("Test", undefined, 3600)).toBe(3600);
    expect(() => requireExpiresInSeconds("Test", "junk", 3600)).toThrow(OAuthTokenResponseError);
    expect(() => requireExpiresInSeconds("Test", undefined)).toThrow(OAuthTokenResponseError);
  });

  test("optionalRefreshToken only accepts non-empty strings", () => {
    expect(optionalRefreshToken("rt")).toBe("rt");
    expect(optionalRefreshToken("")).toBeUndefined();
    expect(optionalRefreshToken(undefined)).toBeUndefined();
    expect(optionalRefreshToken(7)).toBeUndefined();
  });

  test("expiryWithSkew never produces an already-expired credential for short lifetimes", () => {
    const now = 1_000_000;
    expect(expiryWithSkew(now, 3600, 300_000)).toBe(now + 3_600_000 - 300_000);
    // 120s lifetime with a 300s skew would be in the past; skew is capped at half the lifetime.
    expect(expiryWithSkew(now, 120, 300_000)).toBe(now + 60_000);
    expect(expiryWithSkew(now, 120, 300_000)).toBeGreaterThan(now);
  });
});

describe("manual callback input validation", () => {
  const state = "a".repeat(32);
  const other = "b".repeat(32);

  test("url/query input must carry the matching state", () => {
    expect(validateManualCallbackInput(`http://localhost:1/callback?code=c&state=${state}`, state)).toEqual({
      ok: true,
      code: "c",
      state,
    });
    const missing = validateManualCallbackInput("http://localhost:1/callback?code=c", state);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("missing the state");
    const mismatch = validateManualCallbackInput(`?code=c&state=${other}`, state);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error).toContain("state mismatch");
  });

  test("raw code#state with a different state is rejected", () => {
    const bad = validateManualCallbackInput(`code-from-another-attempt#${other}`, state);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("state mismatch");
  });

  test("raw code#state with the matching state is accepted", () => {
    expect(validateManualCallbackInput(`good-code#${state}`, state)).toEqual({ ok: true, code: "good-code", state });
  });

  test("a bare raw code stays accepted (bound to the attempt by PKCE)", () => {
    expect(validateManualCallbackInput("bare-code", state)).toEqual({ ok: true, code: "bare-code" });
    // A trailing empty fragment is a copy artifact, not a state claim.
    expect(validateManualCallbackInput("bare-code#", state)).toEqual({ ok: true, code: "bare-code" });
  });

  test("input without a code is rejected", () => {
    const empty = validateManualCallbackInput("   ", state);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toContain("no authorization code");
  });

  test("state checks are skipped until the flow registers its expected state", () => {
    expect(validateManualCallbackInput(`code#${other}`, undefined)).toEqual({ ok: true, code: "code", state: other });
  });
});

class RecordingFlow extends OAuthCallbackFlow {
  authState = "";
  authRedirect = "";
  exchanged: Array<{ code: string; state: string }> = [];

  async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string }> {
    this.authState = state;
    this.authRedirect = redirectUri;
    return { url: "https://example.test/auth" };
  }

  async exchangeToken(code: string, state: string): Promise<OAuthCredentials> {
    this.exchanged.push({ code, state });
    return { access: "access", refresh: "refresh", expires: Date.now() + 60_000 };
  }
}

function randomPort(): number {
  return 41_000 + Math.floor(Math.random() * 15_000);
}

describe("OAuth callback server", () => {
  test("callback responses are uncacheable, unframeable and leak no referrer", async () => {
    let callbackAssertions: Promise<void> | undefined;
    const ctrl: OAuthController = {
      onAuth: () => {
        callbackAssertions = (async () => {
          const response = await fetch(`${flow.authRedirect}?code=the-code&state=${flow.authState}`);
          expect(response.status).toBe(200);
          expect(response.headers.get("cache-control")).toBe("no-store");
          expect(response.headers.get("referrer-policy")).toBe("no-referrer");
          expect(response.headers.get("x-content-type-options")).toBe("nosniff");
          expect(response.headers.get("x-frame-options")).toBe("DENY");
          expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
          expect(response.headers.get("content-type")).toContain("charset=utf-8");
        })();
      },
    };
    const flow = new RecordingFlow(ctrl, randomPort(), "/callback");
    await flow.login();
    expect(callbackAssertions).toBeDefined();
    await callbackAssertions;
    expect(flow.exchanged).toHaveLength(1);
    expect(flow.exchanged[0]?.code).toBe("the-code");
  });

  test("404 and mismatched-state responses carry the same protective headers and do not consume the flow", async () => {
    const seen: Array<{ status: number; cacheControl: string | null }> = [];
    const ctrl: OAuthController = {
      onAuth: () => {
        void (async () => {
          const missing = await fetch(`${flow.authRedirect.replace("/callback", "/other")}`);
          seen.push({ status: missing.status, cacheControl: missing.headers.get("cache-control") });
          const wrong = await fetch(`${flow.authRedirect}?code=evil&state=${"0".repeat(32)}`);
          seen.push({ status: wrong.status, cacheControl: wrong.headers.get("cache-control") });
          // The legitimate callback still completes the flow afterwards.
          await fetch(`${flow.authRedirect}?code=real&state=${flow.authState}`);
        })();
      },
    };
    const flow = new RecordingFlow(ctrl, randomPort(), "/callback");
    await flow.login();
    expect(seen).toEqual([
      { status: 404, cacheControl: "no-store" },
      { status: 400, cacheControl: "no-store" },
    ]);
    expect(flow.exchanged.map((entry) => entry.code)).toEqual(["real"]);
  });

  test("manual paste with a foreign code#state is ignored and the matching paste wins", async () => {
    let pastes = 0;
    const ctrl: OAuthController = {
      onManualCodeInput: async (expectedState?: string) => {
        pastes += 1;
        if (pastes === 1) return `stale-code#${"f".repeat(32)}`;
        return `fresh-code#${expectedState}`;
      },
    };
    const flow = new RecordingFlow(ctrl, randomPort(), "/callback");
    await flow.login();
    expect(pastes).toBe(2);
    expect(flow.exchanged).toHaveLength(1);
    expect(flow.exchanged[0]?.code).toBe("fresh-code");
    expect(flow.exchanged[0]?.state).toBe(flow.authState);
  });
});

describe("Anthropic token endpoint hardening", () => {
  test("a 200 response without an access token is rejected instead of persisted", async () => {
    mockFetch(() => Response.json({ refresh_token: "rt", expires_in: 3600 }));
    await expect(refreshAnthropicToken("old-rt")).rejects.toThrow("did not include an access token");
  });

  test("a 200 response with a non-numeric expires_in is rejected (no NaN expiry)", async () => {
    mockFetch(() => Response.json({ access_token: "at", refresh_token: "rt", expires_in: "soon" }));
    await expect(refreshAnthropicToken("old-rt")).rejects.toThrow("invalid expires_in");
  });

  test("an unparsable success body is never echoed into the error", async () => {
    mockFetch(() => new Response(`{"access_token":"${LONG_SECRET}","expires_in":`, { status: 200 }));
    const error = await refreshAnthropicToken("old-rt").catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Anthropic OAuth returned invalid JSON");
    expect((error as Error).message).not.toContain("sk-ant");
  });

  test("error responses keep the structured oauthError but never echo secrets from the body", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: "invalid_grant", error_description: `refresh ${LONG_SECRET} revoked` }), {
          status: 400,
        }),
    );
    const error = (await refreshAnthropicToken("old-rt").catch((e: unknown) => e)) as AnthropicTokenError;
    expect(error).toBeInstanceOf(AnthropicTokenError);
    expect(error.httpStatus).toBe(400);
    expect(error.oauthError).toBe("invalid_grant");
    expect(error.message).toContain("Anthropic OAuth HTTP 400: invalid_grant");
    expect(error.message).not.toContain(LONG_SECRET);
  });

  test("an HTML gateway error does not leak into the message", async () => {
    mockFetch(() => new Response("<html>" + "x".repeat(5000) + "</html>", { status: 502 }));
    const error = (await refreshAnthropicToken("old-rt").catch((e: unknown) => e)) as AnthropicTokenError;
    expect(error.message).toBe("Anthropic OAuth HTTP 502");
  });

  test("a short-lived token is not minted already expired", async () => {
    mockFetch(() => Response.json({ access_token: "at", refresh_token: "rt", expires_in: 120 }));
    const before = Date.now();
    const creds = await refreshAnthropicToken("old-rt");
    expect(creds.expires).toBeGreaterThan(before);
    expect(creds.expires).toBeLessThanOrEqual(Date.now() + 120_000);
  });

  test("a refresh response without refresh_token keeps the presented one", async () => {
    mockFetch(() => Response.json({ access_token: "at", expires_in: 3600 }));
    const creds = await refreshAnthropicToken("presented-rt");
    expect(creds.refresh).toBe("presented-rt");
  });
});

describe("ChatGPT token endpoint hardening", () => {
  test("refresh sends a bounded request (abort signal) and keeps the refresh token when omitted", async () => {
    let signal: AbortSignal | null | undefined;
    mockFetch((_url, init) => {
      signal = init?.signal;
      return Response.json({ access_token: "at", expires_in: 3600 });
    });
    const creds = await refreshChatGPTToken("presented-rt");
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(creds.access).toBe("at");
    expect(creds.refresh).toBe("presented-rt");
  });

  test("a rotated refresh token is preferred over the presented one", async () => {
    mockFetch(() => Response.json({ access_token: "at", refresh_token: "rotated", expires_in: 3600 }));
    expect((await refreshChatGPTToken("presented-rt")).refresh).toBe("rotated");
  });

  test("a response without an access token is rejected", async () => {
    mockFetch(() => Response.json({ refresh_token: "rt", expires_in: 3600 }));
    await expect(refreshChatGPTToken("presented-rt")).rejects.toThrow("did not include an access token");
  });

  test("an invalid expires_in is rejected rather than coerced", async () => {
    mockFetch(() => Response.json({ access_token: "at", expires_in: "never" }));
    await expect(refreshChatGPTToken("presented-rt")).rejects.toThrow("invalid expires_in");
  });

  test("a failed refresh reports only safe fields", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: "invalid_grant", error_description: `bad ${LONG_SECRET}` }), { status: 400 }),
    );
    const error = (await refreshChatGPTToken("presented-rt").catch((e: unknown) => e)) as Error;
    expect(error.message).toContain("ChatGPT refresh failed: 400 invalid_grant");
    expect(error.message).not.toContain(LONG_SECRET);
  });
});

describe("generic refresh keeps a stored refresh token the provider omits", () => {
  test("provider that returns no refresh token does not wipe the stored one", async () => {
    await saveCredential("kimi", {
      access: "kimi-old",
      refresh: "stored-refresh",
      expires: Date.now() - 1,
      accountId: "kimi-acct",
    });
    const accountId = getAccountSet("kimi")!.activeAccountId;
    OAUTH_PROVIDERS.kimi!.refresh = async () => ({
      access: "kimi-fresh",
      refresh: "",
      expires: Date.now() + 3_600_000,
    });

    expect(await getValidAccessTokenForAccount("kimi", accountId)).toBe("kimi-fresh");
    expect(getAccountCredential("kimi", accountId)?.refresh).toBe("stored-refresh");
  });
});
