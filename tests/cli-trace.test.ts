import {
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTraceCommand } from "../src/cli/trace";
import {
  closeTraceStore,
  writeTrace,
} from "../src/trace/store";
import {
  resetTraceSettingsForTests,
  setTraceSettings,
} from "../src/trace/settings";

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-cli-trace-"));
  process.env.OPENCODEX_HOME = testDir;
  closeTraceStore();
  resetTraceSettingsForTests();
  setTraceSettings({ mode: "full", ttlHours: 24 });
});

afterEach(() => {
  closeTraceStore();
  resetTraceSettingsForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

async function captureLogs(argv: string[]): Promise<{ code: number; output: string }> {
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(value => String(value)).join(" "));
  });
  const error = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(value => String(value)).join(" "));
  });
  try {
    const code = await handleTraceCommand(argv);
    return { code, output: lines.join("\n") };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

function seedTrace(
  traceId: string,
  conversationId: string,
  createdAt: number,
  model = "gpt-5.6-terra",
): void {
  const stored = writeTrace({
    traceId,
    createdAt,
    mode: "full",
    conversationId,
    provider: "openai",
    model,
    status: 200,
    meta: {
      mode: "full",
      stored: true,
      requestBytes: 22,
      outboundBytes: 23,
      responseBytes: 24,
    },
    inbound: "request-private-marker",
    outbound: "outbound-private-marker",
    response: "\u001b[31mresponse-private-marker",
    truncated: false,
  });
  expect(stored).toBe(true);
}

describe("trace CLI", () => {
  test("show is metadata-only even in JSON unless --body is explicit", async () => {
    seedTrace("trace-1", "conv-1", Date.now());

    const safe = await captureLogs(["show", "trace-1", "--json"]);
    expect(safe.code).toBe(0);
    expect(safe.output).toContain('"traceId": "trace-1"');
    expect(safe.output).not.toContain("request-private-marker");
    expect(safe.output).not.toContain("outbound-private-marker");
    expect(safe.output).not.toContain("response-private-marker");
    expect(safe.output).not.toContain('"inbound"');
    expect(safe.output).not.toContain('"outbound"');
    expect(safe.output).not.toContain('"response"');

    const withBody = await captureLogs(["show", "trace-1", "--body", "--json"]);
    expect(withBody.code).toBe(0);
    expect(withBody.output).toContain("request-private-marker");
    expect(withBody.output).toContain("outbound-private-marker");
    expect(withBody.output).toContain("response-private-marker");
  });

  test("human output escapes terminal control sequences in metadata and bodies", async () => {
    seedTrace("trace-ansi", "conv-1", Date.now(), "\u001b[2Jgpt-private");

    const result = await captureLogs(["show", "trace-ansi", "--body"]);
    expect(result.code).toBe(0);
    expect(result.output).not.toContain("\u001b[");
    expect(result.output).toContain("\\u001b[2Jgpt-private");
    expect(result.output).toContain("\\u001b[31mresponse-private-marker");
  });

  test("list filters by conversation and remains payload-free", async () => {
    const now = Date.now();
    seedTrace("trace-a", "conv-a", now - 1000);
    seedTrace("trace-b", "conv-b", now);

    const result = await captureLogs([
      "list",
      "--conversation",
      "conv-a",
      "--limit",
      "10",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(result.output).toContain('"traceId": "trace-a"');
    expect(result.output).not.toContain('"traceId": "trace-b"');
    expect(result.output).not.toContain("request-private-marker");
    expect(result.output).not.toContain('"inbound"');
  });

  test("rejects unsafe or malformed command shapes", async () => {
    expect((await captureLogs(["show"])).code).toBe(2);
    expect((await captureLogs(["list", "--limit", "501"])).code).toBe(2);
    expect((await captureLogs(["list", "--body"])).code).toBe(2);
    expect((await captureLogs(["show", "missing"])).code).toBe(1);
  });
});
