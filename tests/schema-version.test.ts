import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_SCHEMA_VERSION,
  getConfigPath,
  getDefaultConfig,
  loadConfig,
  readConfigDiagnostics,
  saveConfig,
} from "../src/config";
import type { OcxConfig } from "../src/types";

let testDir = "";

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-schema-version-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  delete process.env.OPENCODEX_HOME;
  if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

function writeLiveShapedConfig(overrides: Record<string, unknown> = {}): string {
  const body = JSON.stringify({
    port: 12345,
    providers: {
      custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
    },
    defaultProvider: "custom",
    ...overrides,
  }, null, 2);
  writeFileSync(getConfigPath(), `${body}\n`, "utf-8");
  return readFileSync(getConfigPath(), "utf-8");
}

describe("schemaVersion", () => {
  test("load without schemaVersion succeeds and does not rewrite the file", () => {
    const before = writeLiveShapedConfig();
    expect(JSON.parse(before).schemaVersion).toBeUndefined();

    const loaded = loadConfig();
    expect(loaded.schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
    expect(loaded.port).toBe(12345);
    expect(loaded.defaultProvider).toBe("custom");
    expect(readFileSync(getConfigPath(), "utf-8")).toBe(before);
  });

  test("readConfigDiagnostics treats missing schemaVersion as 1 without rewriting", () => {
    const before = writeLiveShapedConfig();
    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.source).toBe("file");
    expect(diagnostics.error).toBeNull();
    expect(diagnostics.config.schemaVersion).toBe(1);
    expect(readFileSync(getConfigPath(), "utf-8")).toBe(before);
  });

  test("save writes schemaVersion 1 when the field is absent", () => {
    const config = {
      port: 10100,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
    } as OcxConfig;
    expect(config.schemaVersion).toBeUndefined();
    saveConfig(config);
    expect(config.schemaVersion).toBe(1);
    const written = JSON.parse(readFileSync(getConfigPath(), "utf-8")) as { schemaVersion?: number };
    expect(written.schemaVersion).toBe(1);
  });

  test("getDefaultConfig stamps schemaVersion 1", () => {
    expect(getDefaultConfig().schemaVersion).toBe(1);
  });
});
