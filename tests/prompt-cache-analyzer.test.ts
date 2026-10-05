import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(
  import.meta.dir,
  "../scripts/analyze-prompt-cache-usage.ts",
);
const tempDirs: string[] = [];

function tempUsageFile(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-cache-analyzer-"));
  tempDirs.push(dir);
  const path = join(dir, "usage.jsonl");
  writeFileSync(
    path,
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
  return path;
}

function run(path: string, ...args: string[]) {
  return Bun.spawnSync([process.execPath, script, path, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const now = Date.parse("2026-10-03T12:00:00Z");
const observation = {
  version: 1,
  mode: "default",
  keyPresent: false,
  prewarm: false,
  comparisonRequested: false,
  previousResponseIdPresent: false,
  breakpointCount: 0,
  inputItemCount: 1,
  toolCount: 0,
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: now,
    adapter: "openai-responses",
    provider: "openai",
    model: "test-model",
    surface: "codex",
    status: 200,
    usageStatus: "reported",
    usage: { inputTokens: 100, cacheReadInputTokens: 80 },
    promptCache: observation,
    ...overrides,
  };
}

function analyze(rows: unknown[], ...args: string[]) {
  const result = run(tempUsageFile(rows), `--now=${now}`, "--json", ...args);
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  return JSON.parse(result.stdout.toString());
}

describe("prompt-cache usage analyzer", () => {
  test("is reproducible with --now and keeps cache-shape cohort dimensions", () => {
    const path = tempUsageFile([
      {
        requestId: "r1",
        timestamp: Date.parse("2026-10-02T10:00:00Z"),
        provider: "openai",
        adapter: "openai-responses",
        model: "gpt-5.6-terra",
        resolvedModel: "gpt-5.6-terra",
        surface: "codex",
        status: 200,
        usageStatus: "reported",
        usage: {
          inputTokens: 100,
          outputTokens: 1,
          cacheReadInputTokens: 80,
        },
        promptCache: {
          version: 1,
          keyPresent: false,
          mode: "implicit",
          ttl: "30m",
          prewarm: false,
          comparisonRequested: false,
          previousResponseIdPresent: false,
          breakpointCount: 0,
          inputItemCount: 2,
          toolCount: 1,
          toolsFingerprint: "0123456789abcdef01234567",
          stablePrefixFingerprint: "89abcdef0123456789abcdef",
        },
      },
      {
        requestId: "r2",
        timestamp: Date.parse("2026-10-02T11:00:00Z"),
        provider: "openai",
        adapter: "openai-responses",
        model: "gpt-5.6-terra",
        resolvedModel: "gpt-5.6-terra",
        surface: "codex",
        status: 200,
        usageStatus: "reported",
        usage: {
          inputTokens: 200,
          outputTokens: 1,
          cacheReadInputTokens: 160,
        },
        promptCache: {
          version: 1,
          keyPresent: false,
          mode: "implicit",
          ttl: "30m",
          prewarm: false,
          comparisonRequested: false,
          previousResponseIdPresent: false,
          breakpointCount: 0,
          inputItemCount: 3,
          toolCount: 1,
          toolsFingerprint: "0123456789abcdef01234567",
          stablePrefixFingerprint: "89abcdef0123456789abcdef",
        },
      },
      {
        requestId: "old",
        timestamp: Date.parse("2026-09-20T10:00:00Z"),
        provider: "openai",
        adapter: "openai-responses",
        model: "gpt-5.6-terra",
        status: 200,
        usageStatus: "reported",
        usage: { inputTokens: 999, outputTokens: 1, cacheReadInputTokens: 999 },
      },
    ]);

    const args = ["--range=7d", "--now=2026-10-03T12:00:00Z", "--json"];
    const first = run(path, ...args);
    const second = run(path, ...args);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(first.stdout.toString()).toBe(second.stdout.toString());

    const output = JSON.parse(first.stdout.toString());
    expect(output.windowEnd).toBe("2026-10-03T12:00:00.000Z");
    expect(output.summary).toMatchObject({
      reportedSuccess: 2,
      inputTokens: 300,
      cacheReadTokens: 240,
      cacheReadRatio: 0.8,
    });
    expect(output.cacheShapes).toEqual([
      expect.objectContaining({
        adapter: "openai-responses",
        provider: "openai",
        model: "gpt-5.6-terra",
        surface: "codex",
        mode: "implicit",
        ttl: "30m",
        requests: 2,
        reportedSuccess: 2,
      }),
    ]);
  });

  test("does not treat malformed explicit cache-read usage as legacy cache data", () => {
    const path = tempUsageFile([
      {
        requestId: "malformed-explicit",
        timestamp: Date.parse("2026-10-02T10:00:00Z"),
        provider: "openai",
        model: "gpt-5.6-terra",
        status: 200,
        usageStatus: "reported",
        usage: {
          inputTokens: 100,
          outputTokens: 1,
          cacheReadInputTokens: "not-a-number",
          cachedInputTokens: 90,
        },
      },
      {
        requestId: "legacy-valid",
        timestamp: Date.parse("2026-10-02T11:00:00Z"),
        provider: "openai",
        model: "gpt-5.6-terra",
        status: 200,
        usageStatus: "reported",
        usage: {
          inputTokens: 100,
          outputTokens: 1,
          cachedInputTokens: 60,
        },
      },
    ]);

    const result = run(
      path,
      "--range=7d",
      "--now=2026-10-03T12:00:00Z",
      "--json",
    );
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.toString());
    expect(output.rows).toBe(2);
    expect(output.summary).toMatchObject({
      reportedSuccess: 1,
      inputTokens: 100,
      cacheReadTokens: 60,
      cacheReadRatio: 0.6,
    });
  });

  test("rejects invalid CLI arguments instead of silently changing the analysis", () => {
    const path = tempUsageFile([]);
    const invalidRange = run(path, "--range=week");
    expect(invalidRange.exitCode).toBe(2);
    expect(invalidRange.stderr.toString()).toContain(
      "invalid --range value: week",
    );

    const unknown = run(path, "--bogus");
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr.toString()).toContain("unknown option: --bogus");
  });
});

describe("prompt-cache analyzer boundaries", () => {
  test("counts requests but excludes unproven or inconsistent usage from all measured totals", () => {
    const invalid = [
      row({ status: 201 }),
      row({ status: "200" }),
      row({ status: 500 }),
      ...["estimated", "unsupported", "unreported", undefined].map(
        (usageStatus) => row({ usageStatus }),
      ),
      ...[
        null,
        [],
        {},
        { inputTokens: -1 },
        { inputTokens: "100" },
        { inputTokens: 100, cacheReadInputTokens: -1 },
        { inputTokens: 100, cacheReadInputTokens: null, cachedInputTokens: 80 },
        {
          inputTokens: 100,
          cacheReadInputTokens: 80,
          cacheCreationInputTokens: 21,
        },
      ].map((usage) => row({ usage })),
    ];
    const output = analyze([row(), ...invalid]);
    expect(output.rows).toBe(invalid.length + 1);
    expect(output.summary).toEqual({
      reportedSuccess: 1,
      inputTokens: 100,
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
      uncachedInputTokens: 20,
      cacheReadRatio: 0.8,
      cacheWriteRatio: 0,
    });
    for (const bucket of [output.cohorts[0], output.cacheShapes[0]]) {
      expect(bucket).toMatchObject({
        requests: invalid.length + 1,
        reportedSuccess: 1,
        inputTokens: 100,
        cacheReadTokens: 80,
        cacheReadRatio: 0.8,
      });
    }
    expect(output.cohorts[0].cacheHitRequestRatio).toBe(1);
  });

  test.each([
    {
      usage: {
        inputTokens: 100,
        cachedInputTokens: 80,
        cacheCreationInputTokens: 30,
      },
      read: 50,
      write: 30,
    },
    {
      usage: {
        inputTokens: 100,
        cachedInputTokens: 10,
        cacheCreationInputTokens: 30,
      },
      read: 0,
      write: 30,
    },
    { usage: { inputTokens: 100, cachedInputTokens: 80 }, read: 80, write: 0 },
    {
      usage: {
        inputTokens: 100,
        cachedInputTokens: 90,
        cacheReadInputTokens: 0,
      },
      read: 0,
      write: 0,
    },
    {
      usage: {
        inputTokens: 100,
        cacheReadInputTokens: 70,
        cacheCreationInputTokens: 30,
      },
      read: 70,
      write: 30,
    },
  ])(
    "accounts for legacy and explicit usage: $usage",
    ({ usage, read, write }) => {
      const output = analyze([row({ usage })]);
      expect(output.summary).toMatchObject({
        reportedSuccess: 1,
        inputTokens: 100,
        cacheReadTokens: read,
        cacheWriteTokens: write,
        uncachedInputTokens: 100 - read - write,
      });
      expect(output.cohorts[0]).toMatchObject({
        cacheHitRequestRatio: read > 0 ? 1 : 0,
        cacheWriteRequestRatio: write > 0 ? 1 : 0,
      });
    },
  );

  test.each(["7d", "30d", "all"])(
    "includes both window endpoints for %s",
    (range) => {
      const since =
        range === "all" ? 0 : now - (range === "7d" ? 7 : 30) * 86_400_000;
      const output = analyze(
        [
          ...[since - 1, since, now, now + 1, -1, null, "timestamp"].map(
            (timestamp) => row({ timestamp }),
          ),
          row({ timestamp: undefined }),
        ],
        `--range=${range}`,
      );
      expect(output.windowStartMs).toBe(since);
      expect(output.windowEndMs).toBe(now);
      expect(output.rows).toBe(2);
      expect(output.summary.inputTokens).toBe(200);
    },
  );

  test("reads stdin, counts corrupt lines, and ignores blank lines", () => {
    const result = Bun.spawnSync(
      [process.execPath, script, "-", `--now=${now}`, "--json"],
      {
        stdin: Buffer.from(
          [
            "",
            " ",
            JSON.stringify(row()),
            "{broken",
            "null",
            "[]",
            "42",
            "",
          ].join("\r\n"),
        ),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      source: "stdin",
      invalidLines: 4,
      rows: 1,
      summary: { reportedSuccess: 1 },
    });
  });

  test("keeps dimensions and cache shapes separate, while top limits leave global totals intact", () => {
    const output = analyze([
      row({
        provider: " other ",
        resolvedModel: " resolved ",
        usage: { inputTokens: 300 },
      }),
      row({
        promptCache: { ...observation, mode: "explicit" },
        usage: { inputTokens: 200 },
      }),
      row(),
      row({ adapter: "openai-chat", usage: { inputTokens: 50 } }),
      row({ surface: "claude", usage: { inputTokens: 25 } }),
      row({
        status: 500,
        provider: "failed-only",
        usage: { inputTokens: 999 },
      }),
    ]);
    expect(output.cohorts).toHaveLength(4);
    expect(output.cacheShapes).toHaveLength(5);
    expect(output.cohorts[0]).toMatchObject({
      provider: "other",
      model: "resolved",
      inputTokens: 300,
    });
    expect(output.cohorts[1]).toMatchObject({
      provider: "openai",
      requests: 2,
      inputTokens: 300,
    });
    const limited = analyze(
      [row({ provider: "largest", usage: { inputTokens: 300 } }), row()],
      "--top=1",
    );
    expect(limited.cohorts).toHaveLength(1);
    expect(limited.cacheShapes).toHaveLength(1);
    expect(limited.cohorts[0].provider).toBe("largest");
    expect(limited.summary.inputTokens).toBe(400);
    expect(limited.summary.reportedSuccess).toBe(2);
  });

  test("historical and malformed observations keep usage without creating cache shapes", () => {
    const output = analyze([
      row({
        adapter: undefined,
        promptCache: undefined,
        conversationId: " session ",
      }),
      row({
        adapter: " ",
        promptCache: { ...observation, toolCount: -1 },
        conversationId: "session",
      }),
      row({
        adapter: undefined,
        promptCache: { ...observation, version: 2 },
        conversationId: "other",
      }),
    ]);
    expect(output.cacheShapes).toEqual([]);
    expect(output.cohorts).toEqual([
      expect.objectContaining({
        adapter: "unknown",
        reportedSuccess: 3,
        inputTokens: 300,
        conversations: 2,
        multiTurnConversations: 1,
      }),
    ]);
  });

  test.each([
    { input: 100, read: 9, write: 50, signal: "write-heavy" },
    { input: 100, read: 10, write: 50, signal: "mixed" },
    { input: 999_999, read: 0, write: 0, signal: "mixed" },
    { input: 1_000_000, read: 249_999, write: 0, signal: "low-reuse" },
    { input: 1_000_000, read: 250_000, write: 0, signal: "mixed" },
    { input: 100, read: 75, write: 0, signal: "healthy" },
    { input: 100, read: 74, write: 0, signal: "mixed" },
    { input: 0, read: 0, write: 0, signal: "mixed" },
  ])(
    "classifies signal at threshold $input/$read/$write",
    ({ input, read, write, signal }) => {
      const output = analyze([
        row({
          usage: {
            inputTokens: input,
            cacheReadInputTokens: read,
            cacheCreationInputTokens: write,
          },
        }),
      ]);
      expect(output.cohorts[0].signal).toBe(signal);
      expect(output.summary.cacheReadRatio).toBe(input ? read / input : 0);
      expect(output.summary.cacheWriteRatio).toBe(input ? write / input : 0);
    },
  );

  test("empty windows produce zero ratios and no cohorts", () => {
    const output = analyze([]);
    expect(output.cohorts).toEqual([]);
    expect(output.cacheShapes).toEqual([]);
    expect(output.summary).toEqual({
      reportedSuccess: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      uncachedInputTokens: 0,
      cacheReadRatio: 0,
      cacheWriteRatio: 0,
    });
  });

  test.each([
    "--top=0",
    "--top=201",
    "--top=1.5",
    "--top=abc",
    "--now=invalid",
    "second.jsonl",
  ])("rejects invalid argument %s", (arg) => {
    const result = run(tempUsageFile([]), arg);
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("Usage:");
  });

  test("help does not try to open its input file", () => {
    const path = tempUsageFile([]);
    const result = run(join(path, "missing"), "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Usage:");
    expect(result.stderr.toString()).toBe("");
  });
});
