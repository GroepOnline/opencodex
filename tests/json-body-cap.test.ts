import { describe, expect, test } from "bun:test";
import {
  JSON_REQUEST_BODY_MAX_BYTES,
  readJsonBodyCapped,
  readJsonBodyCappedOr,
  RequestBodyTooLargeError,
} from "../src/lib/request-body";
import { handleManagementAPI } from "../src/server/management-api";
import { ManagementRequest } from "./helpers/management-auth";
import type { OcxConfig } from "../src/types";

const config = { providers: {} } as unknown as OcxConfig;

function streamOf(...sizes: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const size of sizes) controller.enqueue(new Uint8Array(size));
      controller.close();
    },
  });
}

function streamedRequest(
  body: ReadableStream<Uint8Array>,
  headers?: HeadersInit,
): Request {
  return new Request("http://127.0.0.1/x", {
    method: "POST",
    body,
    headers,
    // Required by the fetch spec (and undici/Bun) for streaming request bodies.
    duplex: "half",
  } as RequestInit);
}

describe("readJsonBodyCapped", () => {
  test("parses a JSON body under the cap", async () => {
    const req = new Request("http://127.0.0.1/x", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
    });
    expect(await readJsonBodyCapped(req)).toEqual({ a: 1 });
  });

  test("rejects once streamed bytes cross the cap, even without content-length", async () => {
    const req = streamedRequest(streamOf(8, 8));
    await expect(readJsonBodyCapped(req, 8)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
  });

  test("fails fast on an over-cap declared content-length without parsing", async () => {
    const req = streamedRequest(streamOf(4), { "content-length": "999" });
    await expect(readJsonBodyCapped(req, 8)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
  });

  test("the streamed count stays authoritative when content-length underdeclares", async () => {
    const req = streamedRequest(streamOf(16), { "content-length": "4" });
    await expect(readJsonBodyCapped(req, 8)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
  });

  test("malformed JSON rejects with SyntaxError, matching req.json()", async () => {
    const req = new Request("http://127.0.0.1/x", {
      method: "POST",
      body: "{oops",
    });
    await expect(readJsonBodyCapped(req)).rejects.toBeInstanceOf(SyntaxError);
  });

  test("the error carries the cap and a 413 status for envelope mapping", async () => {
    const req = streamedRequest(streamOf(16));
    const err = await readJsonBodyCapped(req, 8).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestBodyTooLargeError);
    expect((err as RequestBodyTooLargeError).status).toBe(413);
    expect((err as RequestBodyTooLargeError).maxBytes).toBe(8);
  });
});

describe("readJsonBodyCappedOr", () => {
  test("substitutes the fallback for malformed or missing bodies", async () => {
    const bad = new Request("http://127.0.0.1/x", {
      method: "POST",
      body: "{oops",
    });
    expect(await readJsonBodyCappedOr(bad, { ok: true })).toEqual({ ok: true });
    const empty = new Request("http://127.0.0.1/x", { method: "POST" });
    expect(await readJsonBodyCappedOr<unknown>(empty, null)).toBeNull();
  });

  test("still throws over-cap so callers answer 413 instead of applying the fallback", async () => {
    const req = streamedRequest(streamOf(16));
    await expect(readJsonBodyCappedOr(req, {}, 8)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
  });
});

describe("management API body cap", () => {
  test("an over-cap body returns the shared 413 envelope", async () => {
    const padding = "x".repeat(JSON_REQUEST_BODY_MAX_BYTES);
    const req = new ManagementRequest("http://127.0.0.1/api/router", {
      method: "PUT",
      body: `{"mode":"auto","pad":"${padding}"}`,
    });
    const res = await handleManagementAPI(req, new URL(req.url), config);
    expect(res?.status).toBe(413);
    expect(await res!.json()).toEqual({ error: "request body too large" });
  });

  test("a chunked over-cap body cannot bypass the cap via a missing content-length", async () => {
    // The pre-check this replaces only inspected the header; streamed enforcement
    // is what actually bounds the buffered bytes.
    const req = new ManagementRequest("http://127.0.0.1/api/router", {
      method: "PUT",
      body: streamOf(JSON_REQUEST_BODY_MAX_BYTES + 1),
      duplex: "half",
    } as RequestInit);
    const res = await handleManagementAPI(req, new URL(req.url), config);
    expect(res?.status).toBe(413);
  });

  test("an under-cap body still reaches the route", async () => {
    const req = new ManagementRequest("http://127.0.0.1/api/router", {
      method: "PUT",
      body: JSON.stringify({ mode: "bogus" }),
    });
    const res = await handleManagementAPI(req, new URL(req.url), config);
    // 400 from route-level mode validation proves the body parsed normally.
    expect(res?.status).toBe(400);
  });
});
