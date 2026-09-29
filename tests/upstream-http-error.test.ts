import { describe, expect, test } from "bun:test";
import {
  isCloudflareBlockPayload,
  extractCloudflareRayId,
  normalizeUpstreamHttpErrorResponse,
  readDisplaySafeErrorPayloadText,
  sanitizeCloudflareBlockPayload,
  sanitizeUpstreamErrorText,
} from "../src/adapters/upstream-http-error";

describe("sanitizeUpstreamErrorText", () => {
  test("redacts secrets and absolute paths", () => {
    const text = sanitizeUpstreamErrorText(
      "Authorization: Bearer secret-token at /Users/example/private.json and C:\\Users\\JK\\secret.txt",
    );
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain("/Users/example/private.json");
    expect(text).not.toContain("C:\\Users\\JK\\secret.txt");
  });
});

describe("normalizeUpstreamHttpErrorResponse", () => {
  test("strips encoded-length headers and keeps safe headers", async () => {
    const res = new Response("provider-private-detail", {
      status: 503,
      statusText: "Service Unavailable",
      headers: {
        "content-encoding": "gzip",
        "content-length": "999",
        "retry-after": "0",
        "x-provider-error": "kept",
      },
    });

    const normalized = await normalizeUpstreamHttpErrorResponse(res, {
      formatMessage: payloadText => `formatted: ${payloadText}`,
    });

    expect(normalized.status).toBe(503);
    expect(normalized.statusText).toBe("Service Unavailable");
    expect(normalized.headers.get("content-encoding")).toBeNull();
    expect(normalized.headers.get("content-length")).toBeNull();
    expect(normalized.headers.get("retry-after")).toBe("0");
    expect(normalized.headers.get("x-provider-error")).toBe("kept");
    expect(await normalized.text()).toBe("formatted: provider-private-detail");
  });
});

const CF_BLOCK_SAMPLE = `<!DOCTYPE html>
<html lang="en-US"><head><title>Attention Required! | Cloudflare</title></head>
<body><div id="cf-error-details" class="cf-error-details-wrapper">
<h1>Sorry, you have been blocked</h1>
<script>window.__CF$cv$params={r:'a3f104568c229d31',t:'MTc5MDA3NzAzOQ=='};</script>
<script src="/cdn-cgi/challenge-platform/scripts/precursor/main.js"></script>
<p>Cloudflare Ray ID: <strong class="font-semibold">a3f104568c229d31</strong></p>
</div></body></html>`;

const CF_ORIGIN_ERROR_SAMPLE = `<!DOCTYPE html>
<html lang="en-US"><head><title>Web server is down | api.example.test</title></head>
<body><div id="cf-error-details" class="cf-error-details-wrapper">
<h2 class="error-description">Error 521</h2>
<p>Cloudflare Ray ID: <a href="https://dash.cloudflare.com/ray?id=9c0ffee1234567890">9c0ffee1234567890</a></p>
</div></body></html>`;

describe("cloudflare block payload", () => {
  test("detects block pages and extracts the ray id", () => {
    expect(isCloudflareBlockPayload(CF_BLOCK_SAMPLE)).toBe(true);
    expect(extractCloudflareRayId(CF_BLOCK_SAMPLE)).toBe("a3f104568c229d31");
  });

  test("extracts the ray id when it is not wrapped in a <strong> tag", () => {
    expect(extractCloudflareRayId(CF_ORIGIN_ERROR_SAMPLE)).toBe("9c0ffee1234567890");
  });

  test("does not call an origin error page a block", () => {
    expect(isCloudflareBlockPayload(CF_ORIGIN_ERROR_SAMPLE)).toBe(true);
    const sanitized = sanitizeCloudflareBlockPayload(CF_ORIGIN_ERROR_SAMPLE, 521);
    expect(sanitized).toContain("Cloudflare error page (HTTP 521, Error 521)");
    expect(sanitized).not.toContain("rejected before reaching the provider");
    expect(sanitized).toContain("9c0ffee1234567890");
    expect(sanitized).not.toContain("<!DOCTYPE");
    expect(sanitized.length).toBeLessThan(500);
  });

  test("ignores ordinary provider JSON errors", () => {
    const json = `{"error":{"message":"rate limit","code":"RateLimitReached"}}`;
    expect(isCloudflareBlockPayload(json)).toBe(false);
    expect(sanitizeCloudflareBlockPayload(json, 429)).toBe(json);
  });

  test("replaces block HTML with a short actionable message", () => {
    const sanitized = sanitizeCloudflareBlockPayload(CF_BLOCK_SAMPLE, 403);
    expect(sanitized).toContain("Cloudflare edge block (HTTP 403)");
    expect(sanitized).toContain("a3f104568c229d31");
    expect(sanitized).not.toContain("<!DOCTYPE");
    expect(sanitized).not.toContain("__CF$cv$params");
    expect(sanitized.length).toBeLessThan(500);
  });

  test("readDisplaySafeErrorPayloadText never surfaces block HTML", async () => {
    const res = new Response(CF_BLOCK_SAMPLE, { status: 403, statusText: "Forbidden" });
    const text = await readDisplaySafeErrorPayloadText(res);
    expect(text).toContain("Cloudflare edge block");
    expect(text).not.toContain("<!DOCTYPE");
  });

  test("normalizeUpstreamHttpErrorResponse formats the sanitized payload", async () => {
    const res = new Response(CF_BLOCK_SAMPLE, { status: 403, statusText: "Forbidden" });
    const normalized = await normalizeUpstreamHttpErrorResponse(res, {
      formatMessage: payloadText => `upstream: ${payloadText}`,
    });
    const text = await normalized.text();
    expect(text).toContain("Cloudflare edge block");
    expect(text).not.toContain("<!DOCTYPE");
  });
});
