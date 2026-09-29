// Regression coverage for the client-facing surfaces that adopted Cloudflare
// edge HTML verbatim as an upstream error detail. Each test targets a call site
// that reads the body itself instead of going through
// `readDisplaySafeErrorPayloadText`.
import { describe, expect, test } from "bun:test";
import { safeVertexHttpErrorMessage } from "../src/adapters/google-errors";
import { safeKiroHttpErrorMessage } from "../src/adapters/kiro-errors";
import { formatOpenAIChatErrorBody } from "../src/adapters/openai-chat";
import { consumeComboFailure } from "../src/server/responses/core";
import { formatPassthroughUpstreamError } from "../src/server/responses/passthrough-error";

const CF_BLOCK_HTML = `<!DOCTYPE html>
<html lang="en-US"><head><title>Attention Required! | Cloudflare</title></head>
<body><div id="cf-error-details" class="cf-error-details-wrapper">
<h1>Sorry, you have been blocked</h1>
<script>window.__CF$cv$params={r:'a3f104568c229d31',t:'MTc5MDA3NzAzOQ=='};</script>
<script src="/cdn-cgi/challenge-platform/scripts/precursor/main.js"></script>
<p>Cloudflare Ray ID: <strong class="font-semibold">a3f104568c229d31</strong></p>
</div></body></html>`;

const CF_ORIGIN_ERROR_HTML = `<!DOCTYPE html>
<html lang="en-US"><head><title>Web server is down | api.example.test</title></head>
<body><div id="cf-error-details" class="cf-error-details-wrapper">
<h2 class="error-description">Error 521</h2>
<p>Cloudflare Ray ID: <strong>9c0ffee1234567890</strong></p>
</div></body></html>`;

describe("cloudflare HTML in client-facing error messages", () => {
  test("google formatter never echoes block HTML", () => {
    const message = safeVertexHttpErrorMessage(403, CF_BLOCK_HTML);
    expect(message).toContain("Cloudflare edge block");
    expect(message).toContain("a3f104568c229d31");
    expect(message).not.toContain("<!DOCTYPE");
    expect(message).not.toContain("__CF$cv$params");
    expect(message.length).toBeLessThan(600);
  });

  test("kiro formatter never echoes block HTML", () => {
    const message = safeKiroHttpErrorMessage(403, new Headers(), CF_BLOCK_HTML);
    expect(message).toContain("Cloudflare edge block");
    expect(message).not.toContain("<!DOCTYPE");
    expect(message.length).toBeLessThan(600);
  });

  test("combo failure never echoes block HTML", async () => {
    const failure = await consumeComboFailure(new Response(CF_BLOCK_HTML, { status: 403 }));
    const body = await failure.response.json() as { error?: { message?: string } };
    expect(body.error?.message).toContain("Cloudflare edge block");
    expect(body.error?.message).not.toContain("<!DOCTYPE");
    expect(failure.response.status).toBe(403);
  });

  test("combo failure reports an origin error page as such", async () => {
    const failure = await consumeComboFailure(new Response(CF_ORIGIN_ERROR_HTML, { status: 521 }));
    const body = await failure.response.json() as { error?: { message?: string } };
    expect(body.error?.message).toContain("Cloudflare error page (HTTP 521, Error 521)");
    expect(body.error?.message).not.toContain("rejected before reaching the provider");
    expect(body.error?.message).not.toContain("<!DOCTYPE");
  });

  test("openai-chat formatter still returns nothing for HTML bodies", () => {
    expect(formatOpenAIChatErrorBody(403, new Headers(), CF_BLOCK_HTML)).toBe("");
  });

  test("passthrough relays a cloudflare page as plain text", async () => {
    const response = formatPassthroughUpstreamError(403, CF_BLOCK_HTML, {
      headers: new Headers({ "Content-Type": "text/html; charset=utf-8" }),
    });
    const text = await response.text();
    expect(response.status).toBe(403);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(text).toContain("Cloudflare edge block");
    expect(text).not.toContain("<!DOCTYPE");
  });

  test("passthrough keeps non-cloudflare bodies byte-identical", async () => {
    const nginx = "<html><body><h1>502 Bad Gateway</h1></body></html>";
    const response = formatPassthroughUpstreamError(502, nginx, {
      headers: new Headers({ "Content-Type": "text/html" }),
    });
    expect(await response.text()).toBe(nginx);
    expect(response.headers.get("Content-Type")).toBe("text/html");
  });

  test("ordinary provider JSON is passed through unchanged", () => {
    const json = `{"error":{"message":"rate limit","code":"RateLimitReached"}}`;
    expect(safeVertexHttpErrorMessage(429, json)).toContain("rate limit");
    expect(safeKiroHttpErrorMessage(429, new Headers(), json)).toContain("rate limit");
  });
});
