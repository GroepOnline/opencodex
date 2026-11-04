import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  antigravityCliTokenPath,
  detectAntigravityCliToken,
} from "../src/oauth/local-token-detect";
import {
  importAntigravityCliSession,
  loginAntigravityWithImport,
} from "../src/oauth/google-antigravity";
import type { OAuthController } from "../src/oauth/types";

const origFetch = globalThis.fetch;
const origHome = process.env.HOME;
let tmp: string;

beforeEach(() => {
  tmp = join(
    tmpdir(),
    `ag-agy-import-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(tmp, { recursive: true });
  process.env.HOME = tmp;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  rmSync(tmp, { recursive: true, force: true });
});

/** Write an `agy` session file in the exact shape the Antigravity CLI writes. */
function writeAgySession(body: unknown): void {
  const path = antigravityCliTokenPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(body));
}

function ctrl(): OAuthController {
  return { onProgress: () => {}, signal: new AbortController().signal };
}

/** Respond to the token refresh, userinfo and CCA discovery calls the import makes. */
function mockImportFetch(
  opts: { project?: string | null; identity?: boolean } = {},
): void {
  const project =
    opts.project === undefined ? "aicode-consumers" : opts.project;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      return Response.json({
        access_token: "ya29.fresh",
        expires_in: 3600,
        refresh_token: "1//rotated",
      });
    }
    if (url.includes("userinfo")) {
      if (opts.identity === false) return new Response("nope", { status: 401 });
      return Response.json({
        email: "Chef@Example.COM",
        id: "103931788374873061466",
      });
    }
    if (url.includes("loadCodeAssist")) {
      return Response.json(project ? { cloudaicompanionProject: project } : {});
    }
    if (url.includes("onboardUser")) {
      return Response.json(
        project
          ? { done: true, response: { cloudaicompanionProject: project } }
          : { done: true, response: {} },
      );
    }
    return new Response("unexpected " + url, { status: 404 });
  }) as typeof fetch;
}

describe("Antigravity CLI session detection", () => {
  test("reads the refresh token from the agy session file", () => {
    writeAgySession({
      token: {
        access_token: "ya29.stale",
        refresh_token: "1//08old",
        expiry: "2026-10-14T10:51:12.020514104Z",
      },
      auth_method: "consumer",
      id_token: "eyJhbGciOiJS",
    });
    const detected = detectAntigravityCliToken();
    expect(detected?.refresh).toBe("1//08old");
    expect(detected?.expires).toBe(
      Date.parse("2026-10-14T10:51:12.020514104Z"),
    );
  });

  test("returns null when the session file is absent", () => {
    expect(detectAntigravityCliToken()).toBeNull();
  });

  test("returns null for a malformed or refresh-less file instead of throwing", () => {
    writeAgySession({ token: { access_token: "ya29.x" } });
    expect(detectAntigravityCliToken()).toBeNull();
    writeFileSync(antigravityCliTokenPath(), "not json");
    expect(detectAntigravityCliToken()).toBeNull();
  });

  test("falls back to expires 0 when the CLI omits a parseable expiry", () => {
    writeAgySession({ token: { refresh_token: "1//x", expiry: "not-a-date" } });
    expect(detectAntigravityCliToken()).toEqual({
      refresh: "1//x",
      expires: 0,
    });
  });
});

describe("Antigravity CLI import", () => {
  test("always exchanges the on-disk refresh token instead of trusting the stored access token", async () => {
    writeAgySession({
      token: { access_token: "ya29.stale", refresh_token: "1//08old" },
    });
    let sawRefreshGrant = false;
    const inner = globalThis.fetch;
    mockImportFetch();
    const base = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (String(input).includes("oauth2.googleapis.com/token")) {
        const body = String(init?.body ?? "");
        sawRefreshGrant =
          body.includes("grant_type=refresh_token") &&
          body.includes("1%2F%2F08old");
      }
      return await base(input as RequestInfo, init);
    }) as typeof fetch;
    void inner;

    const creds = await importAntigravityCliSession(ctrl());
    expect(sawRefreshGrant).toBe(true);
    expect(creds.access).toBe("ya29.fresh");
    expect(creds.email).toBe("chef@example.com");
    expect(creds.accountId).toBe("103931788374873061466");
    expect(creds.projectId).toBe("aicode-consumers");
  });

  test("returns null when no agy session exists so the caller can fall back to browser login", async () => {
    expect(await importAntigravityCliSession(ctrl())).toBeNull();
  });

  test("fails closed when the Google identity cannot be verified", async () => {
    writeAgySession({ token: { refresh_token: "1//08old" } });
    mockImportFetch({ identity: false });
    await expect(importAntigravityCliSession(ctrl())).rejects.toThrow(
      /identity could not be verified/,
    );
  });

  test("fails closed when no Cloud Code Assist project is discovered", async () => {
    writeAgySession({ token: { refresh_token: "1//08old" } });
    mockImportFetch({ project: null });
    await expect(importAntigravityCliSession(ctrl())).rejects.toThrow(
      /no Cloud Code Assist project/,
    );
  });
});

describe("loginAntigravityWithImport modes", () => {
  test("importLocal 'only' refuses to fall back to browser login when no session exists", async () => {
    await expect(
      loginAntigravityWithImport(ctrl(), { importLocal: "only" }),
    ).rejects.toThrow(/No Antigravity CLI session found/);
  });

  test("the default mode imports when a session exists", async () => {
    writeAgySession({ token: { refresh_token: "1//08old" } });
    mockImportFetch();
    const creds = await loginAntigravityWithImport(ctrl(), {
      importLocal: "fallback",
    });
    expect(creds.projectId).toBe("aicode-consumers");
  });

  test("'off' never reads the local session", async () => {
    writeAgySession({ token: { refresh_token: "1//08old" } });
    let touchedTokenEndpoint = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("oauth2.googleapis.com/token"))
        touchedTokenEndpoint = true;
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    // Browser flow starts by generating an auth URL; it must not have imported first.
    const promise = loginAntigravityWithImport(ctrl(), { importLocal: "off" });
    await expect(promise).rejects.toThrow();
    expect(touchedTokenEndpoint).toBe(false);
  });
});
