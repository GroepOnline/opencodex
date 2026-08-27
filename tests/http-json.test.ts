import { describe, expect, test } from "bun:test";
import { formatErrorResponse } from "../src/bridge";
import { stringifyHttpJson } from "../src/lib/http-json";

describe("stringifyHttpJson", () => {
  test("omits Error.stack and stack-frame tails from the HTTP body", () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n    at go (/abs/src/server.ts:120:13)\n    at processTicksAndRejections (native:7:39)";
    const body = stringifyHttpJson({ error: err, nested: { stack: "secret-frames" } });
    expect(body).not.toContain("/abs/src/server.ts");
    expect(body).not.toContain("processTicksAndRejections");
    expect(body).not.toContain("secret-frames");
    expect(JSON.parse(body)).toEqual({ error: "Error: boom", nested: {} });
  });

  test("strips interpolated stack frames from string fields and keeps the message", () => {
    const body = stringifyHttpJson({
      error: "upstream failed\n    at relay (/abs/src/server/relay.ts:88:7)",
    });
    expect(body).not.toContain("relay.ts");
    expect(JSON.parse(body)).toEqual({ error: "upstream failed" });
  });

  test("keeps ordinary multiline text that is not a stack frame", () => {
    const body = stringifyHttpJson({ text: "Meet\n    at 9:00", note: "look at this" });
    expect(JSON.parse(body)).toEqual({ text: "Meet\n    at 9:00", note: "look at this" });
  });
});

describe("formatErrorResponse", () => {
  test("does not echo a stack through the classified error payload", async () => {
    const response = formatErrorResponse(
      502,
      "upstream_error",
      "Provider exploded\n    at adapter (/abs/src/adapters/x.ts:9:1)",
    );
    const payload = await response.json() as { error: { message: string } };
    expect(payload.error.message).toBe("Provider exploded");
    expect(JSON.stringify(payload)).not.toContain("adapters/x.ts");
  });
});
