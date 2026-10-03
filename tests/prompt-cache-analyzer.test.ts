import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../scripts/analyze-prompt-cache-usage.ts");
const tempDirs: string[] = [];

function tempUsageFile(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-cache-analyzer-"));
  tempDirs.push(dir);
  const path = join(dir, "usage.jsonl");
  writeFileSync(path, lines.map(line => JSON.stringify(line)).join("\n") + "\n");
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

  test("rejects invalid CLI arguments instead of silently changing the analysis", () => {
    const path = tempUsageFile([]);
    const invalidRange = run(path, "--range=week");
    expect(invalidRange.exitCode).toBe(2);
    expect(invalidRange.stderr.toString()).toContain("invalid --range value: week");

    const unknown = run(path, "--bogus");
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr.toString()).toContain("unknown option: --bogus");
  });
});
