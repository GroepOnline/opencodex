import { afterEach, describe, expect, test } from "bun:test";
import {
  loadSessionIdentity,
  parseSessionIdentity,
} from "../src/session-identity";

describe("parseSessionIdentity", () => {
  test("accepts a verified email and source", () => {
    expect(
      parseSessionIdentity({ email: "Operator@Example.test", source: "oidc" }),
    ).toEqual({
      email: "operator@example.test",
      source: "oidc",
    });
  });

  test("rejects missing, oversized, or token-shaped payloads", () => {
    expect(parseSessionIdentity(null)).toEqual({ email: null, source: "none" });
    expect(
      parseSessionIdentity({ email: "not-an-email", source: "cf-access" }),
    ).toEqual({
      email: null,
      source: "cf-access",
    });
    expect(
      parseSessionIdentity({ email: `${"a".repeat(251)}@x.y`, source: "oidc" }),
    ).toEqual({
      email: null,
      source: "oidc",
    });
    expect(
      parseSessionIdentity({
        email: "operator@example.test",
        token: "secret",
        source: "jwt",
      }),
    ).toEqual({
      email: "operator@example.test",
      source: "none",
    });
  });
});

describe("loadSessionIdentity", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("prefers management whoami over Cloudflare get-identity", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/api/whoami")) {
        return new Response(
          JSON.stringify({ email: "operator@example.test", source: "oidc" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    await expect(loadSessionIdentity()).resolves.toEqual({
      email: "operator@example.test",
      source: "oidc",
    });
    expect(calls).toEqual(["/api/whoami"]);
  });

  test("falls back to Cloudflare get-identity email only", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/whoami")) {
        return new Response(JSON.stringify({ email: null, source: "none" }), {
          status: 200,
        });
      }
      if (url.includes("/cdn-cgi/access/get-identity")) {
        return new Response(
          JSON.stringify({
            email: "operator@example.test",
            idp: { name: "authentik" },
            groups: [],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    await expect(loadSessionIdentity()).resolves.toEqual({
      email: "operator@example.test",
      source: "cf-access",
    });
  });
});
