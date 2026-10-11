import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getValidAccessTokenForAccount, OAuthLoginRequiredError } from "../src/oauth";
import {
  AntigravityOAuthFlow,
  fetchAntigravityIdentity,
  refreshAntigravityToken,
} from "../src/oauth/google-antigravity";
import { getAccountSet, saveCredential } from "../src/oauth/store";

const origFetch = globalThis.fetch;
const origHome = process.env.HOME;
const origOcxHome = process.env.OPENCODEX_HOME;
let tmp: string;

beforeEach(() => {
  tmp = join(tmpdir(), `ag-identity-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
  process.env.HOME = tmp;
  process.env.OPENCODEX_HOME = join(tmp, "ocx");
});

afterEach(() => {
  globalThis.fetch = origFetch;
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

describe("Antigravity identity lookup", () => {
  test("returns lowercased email and stable Google id from userinfo", async () => {
    mockFetch((url, init) => {
      expect(url).toContain("googleapis.com/oauth2/v2/userinfo");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer ya29.token");
      return Response.json({ email: "Someone@Example.COM", id: "1234567890" });
    });
    expect(await fetchAntigravityIdentity("ya29.token")).toEqual({ email: "someone@example.com", accountId: "1234567890" });
  });

  test("failures degrade to an empty identity instead of failing login", async () => {
    mockFetch(() => new Response("nope", { status: 401 }));
    expect(await fetchAntigravityIdentity("t")).toEqual({});
    mockFetch(() => {
      throw new Error("network down");
    });
    expect(await fetchAntigravityIdentity("t")).toEqual({});
    mockFetch(() => new Response("<html>", { status: 200 }));
    expect(await fetchAntigravityIdentity("t")).toEqual({});
  });

  test("code exchange stores email + accountId so a second Google account is a separate account", async () => {
    const accounts = [
      { email: "first@example.com", id: "g-1", project: "proj-1" },
      { email: "second@example.com", id: "g-2", project: "proj-2" },
    ];
    for (const account of accounts) {
      mockFetch((url) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          return Response.json({ access_token: `ya29.${account.id}`, refresh_token: `rt-${account.id}`, expires_in: 3599 });
        }
        if (url.includes("userinfo")) return Response.json({ email: account.email, id: account.id });
        if (url.includes(":loadCodeAssist")) return Response.json({ cloudaicompanionProject: account.project });
        return new Response("no", { status: 404 });
      });
      const flow = new AntigravityOAuthFlow({});
      await flow.generateAuthUrl("state", "http://127.0.0.1:51121/callback");
      const creds = await flow.exchangeToken("code", "state", "http://127.0.0.1:51121/callback");
      expect(creds.email).toBe(account.email);
      expect(creds.accountId).toBe(account.id);
      expect(creds.projectId).toBe(account.project);
      await saveCredential("google-antigravity", creds);
    }
    const set = getAccountSet("google-antigravity")!;
    expect(set.accounts.map((a) => a.credential.email).sort()).toEqual(["first@example.com", "second@example.com"]);
  });

  test("login still succeeds (identity-less) when userinfo is unavailable", async () => {
    mockFetch((url) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return Response.json({ access_token: "ya29.x", refresh_token: "rt", expires_in: 3599 });
      }
      if (url.includes("userinfo")) return new Response("down", { status: 503 });
      if (url.includes(":loadCodeAssist")) return Response.json({ cloudaicompanionProject: "proj" });
      return new Response("no", { status: 404 });
    });
    const flow = new AntigravityOAuthFlow({});
    await flow.generateAuthUrl("state", "http://127.0.0.1:51121/callback");
    const creds = await flow.exchangeToken("code", "state", "http://127.0.0.1:51121/callback");
    expect(creds.email).toBeUndefined();
    expect(creds.accountId).toBeUndefined();
    expect(creds.projectId).toBe("proj");
  });
});

describe("Antigravity refresh failure classification", () => {
  test("surfaces only an allowlisted OAuth error code, never the description", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), {
          status: 400,
        }),
    );
    const error = (await refreshAntigravityToken("rt").catch((e: unknown) => e)) as Error;
    expect(error.message).toBe("Antigravity token request failed: 400 invalid_grant");
    expect(error.message).not.toContain("expired or revoked");
  });

  test("an unknown error value in the body is not echoed", async () => {
    mockFetch(() => new Response(JSON.stringify({ error: "leaky_value_1234567890_secret" }), { status: 400 }));
    const error = (await refreshAntigravityToken("rt").catch((e: unknown) => e)) as Error;
    expect(error.message).toBe("Antigravity token request failed: 400");
  });

  test("a non-JSON success body gives a clear error", async () => {
    mockFetch(() => new Response("<html>", { status: 200 }));
    await expect(refreshAntigravityToken("rt")).rejects.toThrow("not valid JSON");
  });

  test("a revoked grant marks the account needs-reauth instead of retrying forever", async () => {
    await saveCredential("google-antigravity", {
      access: "old",
      refresh: "revoked-rt",
      expires: Date.now() - 1,
      email: "gone@example.com",
      accountId: "g-gone",
      projectId: "proj",
    });
    const accountId = getAccountSet("google-antigravity")!.activeAccountId;
    mockFetch(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));

    await expect(getValidAccessTokenForAccount("google-antigravity", accountId)).rejects.toBeInstanceOf(
      OAuthLoginRequiredError,
    );
    const account = getAccountSet("google-antigravity")!.accounts.find((a) => a.id === accountId);
    expect(account?.needsReauth).toBe(true);
  });

  test("a transient 503 does not mark the account needs-reauth", async () => {
    await saveCredential("google-antigravity", {
      access: "old",
      refresh: "rt",
      expires: Date.now() - 1,
      email: "ok@example.com",
      accountId: "g-ok",
      projectId: "proj",
    });
    const accountId = getAccountSet("google-antigravity")!.activeAccountId;
    mockFetch(() => new Response("unavailable", { status: 503 }));

    await expect(getValidAccessTokenForAccount("google-antigravity", accountId)).rejects.toThrow();
    const account = getAccountSet("google-antigravity")!.accounts.find((a) => a.id === accountId);
    expect(account?.needsReauth).toBeUndefined();
  });
});
