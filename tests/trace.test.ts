import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendTraceResponse,
  beginTrace,
  createTraceCapture,
  finalizeTrace,
  noteOutboundRequestBody,
  runWithTrace,
  sectionHashes,
  shapeOf,
  type TraceCapture,
} from "../src/trace/capture";
import {
  getTraceSettings,
  resetTraceSettingsForTests,
  setTraceSettings,
} from "../src/trace/settings";
import {
  closeTraceStore,
  listTraces,
  pruneTraces,
  readTrace,
  writeTrace,
} from "../src/trace/store";
import { normalizeUsageTraceMeta } from "../src/trace/types";
import {
  appendUsageEntry,
  readUsageEntries,
  resetUsageReadCacheForTests,
} from "../src/usage/log";

let testDir = "";
let previousHome: string | undefined;
const traceEnvNames = [
  "OCX_TRACE",
  "OCX_TRACE_TTL_HOURS",
  "OCX_TRACE_MAX_BODY_BYTES",
  "OCX_TRACE_MAX_DB_MB",
  "OCX_TRACE_SAMPLE",
] as const;
let previousTraceEnv: Partial<Record<(typeof traceEnvNames)[number], string>> = {};

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousTraceEnv = {};
  for (const name of traceEnvNames) {
    const value = process.env[name];
    if (value !== undefined) previousTraceEnv[name] = value;
    delete process.env[name];
  }
  testDir = mkdtempSync(join(tmpdir(), "ocx-trace-"));
  process.env.OPENCODEX_HOME = testDir;
  resetUsageReadCacheForTests();
  resetTraceSettingsForTests();
});

afterEach(() => {
  closeTraceStore();
  resetTraceSettingsForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  for (const name of traceEnvNames) {
    const value = previousTraceEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

const body = (extra: Record<string, unknown> = {}, last = "hello") =>
  JSON.stringify({
    model: "gpt-x",
    instructions: "be brief",
    tools: [
      { type: "function", name: "a" },
      { type: "function", name: "b" },
    ],
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "first" },
          { type: "input_image", image_url: "data:x" },
        ],
      },
      { type: "function_call", name: "a", arguments: "{}" },
      { role: "user", content: last },
    ],
    ...extra,
  });

describe("trace settings", () => {
  test("defaults to off and clamps env values", () => {
    expect(getTraceSettings().mode).toBe("off");
    process.env.OCX_TRACE = "REDACTED";
    process.env.OCX_TRACE_TTL_HOURS = "99999";
    process.env.OCX_TRACE_SAMPLE = "7";
    const s = getTraceSettings();
    expect(s.mode).toBe("redacted");
    expect(s.ttlHours).toBe(720);
    expect(s.sample).toBe(1);
  });

  test("invalid mode falls back to off", () => {
    process.env.OCX_TRACE = "everything";
    expect(getTraceSettings().mode).toBe("off");
  });

  test("off creates no capture", () => {
    expect(createTraceCapture()).toBeUndefined();
  });
});

describe("body shape and section hashes", () => {
  test("counts messages, tool calls, tool defs and attachments", () => {
    const shape = shapeOf(JSON.parse(body()));
    expect(shape.messageCount).toBe(3);
    expect(shape.toolCallCount).toBe(1);
    expect(shape.toolDefCount).toBe(2);
    expect(shape.attachmentCount).toBe(1);
  });

  test("prefixHash survives a new last turn; systemHash/toolsHash localize the change", () => {
    const a = sectionHashes(JSON.parse(body({}, "one")));
    const b = sectionHashes(JSON.parse(body({}, "two")));
    expect(a.prefixHash).toBe(b.prefixHash);
    const c = sectionHashes(
      JSON.parse(body({ instructions: "be verbose" }, "one")),
    );
    expect(c.systemHash).not.toBe(a.systemHash);
    expect(c.toolsHash).toBe(a.toolsHash);
    expect(c.prefixHash).toBe(a.prefixHash);
    const d = sectionHashes(
      JSON.parse(body({ tools: [{ type: "function", name: "z" }] }, "one")),
    );
    expect(d.toolsHash).not.toBe(a.toolsHash);
  });
});

describe("trace store", () => {
  test("round-trips gzip bodies and lists by conversation", () => {
    const meta = { mode: "full" as const, stored: true };
    expect(
      writeTrace({
        traceId: "r1",
        createdAt: 1,
        mode: "full",
        conversationId: "c1",
        meta,
        inbound: "in",
        outbound: "out",
        response: "res",
        truncated: false,
      }),
    ).toBe(true);
    const row = readTrace("r1");
    expect(row?.inbound).toBe("in");
    expect(row?.outbound).toBe("out");
    expect(row?.response).toBe("res");
    expect(listTraces({ conversationId: "c1" }).map((r) => r.traceId)).toEqual([
      "r1",
    ]);
    expect(listTraces({ conversationId: "other" })).toEqual([]);
  });

  test("expired rows are invisible and physically pruned on read activity", () => {
    setTraceSettings({ ttlHours: 1 });
    writeTrace({
      traceId: "old",
      createdAt: 1,
      mode: "full",
      meta: { mode: "full", stored: true },
      inbound: "x",
      truncated: false,
    });
    const later = Date.now() + 2 * 3_600_000;
    expect(readTrace("old", later)).toBeNull();
    expect(pruneTraces(later)).toBe(0);
  });
});

describe("finalizeTrace", () => {
  function capture(mode: "metadata" | "redacted" | "full"): TraceCapture {
    setTraceSettings({ mode });
    const trace = createTraceCapture();
    if (!trace) throw new Error("capture expected");
    return trace;
  }

  test("metadata mode stores no bodies but fills hashes and counts", () => {
    const trace = capture("metadata");
    trace.inbound = body();
    trace.inboundBytes = Buffer.byteLength(trace.inbound);
    const out = finalizeTrace("m1", { trace }, { timestamp: 1 });
    expect(out.traceId).toBeUndefined();
    expect(out.trace?.stored).toBe(false);
    expect(out.trace?.messageCount).toBe(3);
    expect(out.trace?.requestHash).toMatch(/^[0-9a-f]{32}$/);
    expect(readTrace("m1")).toBeNull();
  });

  test("redacted mode strips secrets from stored bodies but hashes the raw body", () => {
    const trace = capture("redacted");
    const secret = "sk-abcdefghijklmnop";
    trace.inbound = body({
      api_key: "k-123456789",
      note: `use ${secret} please`,
    });
    trace.inboundBytes = Buffer.byteLength(trace.inbound);
    const raw = trace.inbound;
    appendTraceResponse(trace, `data: {"token":"tok_live_abcdef123456"}`);
    const out = finalizeTrace(
      "r1",
      { trace },
      {
        timestamp: 5,
        conversationId: "c9",
        provider: "p",
        model: "m",
        status: 200,
      },
    );
    expect(out.traceId).toBe("r1");
    expect(out.trace?.stored).toBe(true);
    const row = readTrace("r1");
    expect(row?.inbound).not.toContain(secret);
    expect(row?.inbound).not.toContain("k-123456789");
    expect(row?.inbound).toContain("[REDACTED]");
    expect(row?.response).not.toContain("tok_live_abcdef123456");
    expect(row?.conversationId).toBe("c9");
    expect(out.trace?.requestHash).toBeDefined();
    expect(out.trace?.requestHash).toBe(finalizeHashOf(raw));
  });

  test("redacted mode preserves structured redaction across response chunks", () => {
    const trace = capture("redacted");
    appendTraceResponse(trace, JSON.stringify({ password: "plain-private-value" }));
    appendTraceResponse(trace, JSON.stringify({ ok: true }));
    const out = finalizeTrace("r2", { trace }, { timestamp: 1 });
    expect(out.trace?.stored).toBe(true);
    const row = readTrace("r2");
    expect(row?.response).not.toContain("plain-private-value");
    expect(row?.response).toContain("[REDACTED]");
  });

  test("full mode keeps bodies verbatim and caps stored UTF-8 bytes", () => {
    setTraceSettings({ mode: "full", maxBodyBytes: 4096 });
    const trace = createTraceCapture()!;
    trace.inbound = "😀".repeat(3000);
    trace.inboundBytes = Buffer.byteLength(trace.inbound);
    const out = finalizeTrace("f1", { trace }, { timestamp: 1 });
    expect(out.trace?.requestBytes).toBe(12_000);
    const row = readTrace("f1");
    expect(Buffer.byteLength(row?.inbound ?? "", "utf8")).toBeLessThanOrEqual(4096);
    expect(row?.inbound).not.toContain("�");
    expect(row?.truncated).toBe(true);
  });

  test("response capture counts UTF-8 bytes and separators against the cap", () => {
    setTraceSettings({ mode: "full", maxBodyBytes: 4096 });
    const trace = createTraceCapture()!;
    appendTraceResponse(trace, "😀".repeat(1500));
    appendTraceResponse(trace, "界".repeat(1500));
    const out = finalizeTrace("f2", { trace }, { timestamp: 1 });
    expect(out.trace?.responseBytes).toBe(10_500);
    const row = readTrace("f2");
    expect(Buffer.byteLength(row?.response ?? "", "utf8")).toBeLessThanOrEqual(4096);
    expect(row?.response).not.toContain("�");
    expect(row?.truncated).toBe(true);
  });

  test("is idempotent", () => {
    const trace = capture("full");
    trace.inbound = "{}";
    const ctx = { trace };
    expect(finalizeTrace("i1", ctx, { timestamp: 1 }).trace).toBeDefined();
    expect(finalizeTrace("i1", ctx, { timestamp: 1 })).toEqual({});
  });
});

function finalizeHashOf(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 32);
}

describe("outbound capture", () => {
  test("records the last wire body inside runWithTrace and ignores calls outside it", () => {
    setTraceSettings({ mode: "metadata" });
    const logCtx: { trace?: TraceCapture } = { trace: createTraceCapture() };
    noteOutboundRequestBody("outside");
    runWithTrace(logCtx, () => {
      noteOutboundRequestBody("first");
      noteOutboundRequestBody(body());
    });
    expect(logCtx.trace?.outboundCount).toBe(2);
    const out = finalizeTrace("o1", logCtx, { timestamp: 1 });
    expect(out.trace?.outboundCount).toBe(2);
    expect(out.trace?.toolsHash).toBeDefined();
    expect(out.trace?.outboundHash).toBe(finalizeHashOf(body()));
  });
});

describe("beginTrace", () => {
  test("reads the inbound body from a clone and leaves the request readable", async () => {
    setTraceSettings({ mode: "metadata" });
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      body: body(),
    });
    const logCtx: { trace?: TraceCapture } = {};
    await beginTrace(logCtx, req);
    expect(logCtx.trace?.inboundBytes).toBe(Buffer.byteLength(body()));
    expect(await req.text()).toBe(body());
  });

  test("stops reading a chunked clone once the inbound byte limit is exceeded", async () => {
    setTraceSettings({ mode: "metadata" });
    const chunk = new Uint8Array(1024 * 1024);
    const totalChunks = 20;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
        if (pulls >= totalChunks) controller.close();
      },
    });
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      body: stream,
    });
    const logCtx: { trace?: TraceCapture } = {};
    await beginTrace(logCtx, req);
    expect(logCtx.trace).toBeDefined();
    expect(logCtx.trace?.inbound).toBeUndefined();
    expect(pulls).toBeLessThan(totalChunks);
  });

  test("does nothing when off", async () => {
    const logCtx: { trace?: TraceCapture } = {};
    await beginTrace(
      logCtx,
      new Request("http://localhost/x", { method: "POST", body: "{}" }),
    );
    expect(logCtx.trace).toBeUndefined();
  });
});

describe("usage.jsonl integration", () => {
  test("persists traceId and normalized trace meta, drops junk", () => {
    appendUsageEntry({
      requestId: "u1",
      timestamp: 1,
      provider: "p",
      model: "m",
      status: 200,
      durationMs: 1,
      usageStatus: "reported",
      traceId: "u1",
      trace: {
        mode: "redacted",
        stored: true,
        requestBytes: 10,
        requestHash: "a".repeat(32),
        prefixHash: "nothex!",
      } as never,
    });
    const [entry] = readUsageEntries();
    expect(entry?.traceId).toBe("u1");
    expect(entry?.trace?.mode).toBe("redacted");
    expect(entry?.trace?.requestBytes).toBe(10);
    expect(entry?.trace?.prefixHash).toBeUndefined();
  });

  test("normalizeUsageTraceMeta rejects unknown modes", () => {
    expect(normalizeUsageTraceMeta({ mode: "bogus" })).toBeUndefined();
    expect(normalizeUsageTraceMeta(null)).toBeUndefined();
  });
});
