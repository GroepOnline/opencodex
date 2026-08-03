import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  persistentClaudeEnv,
  syncClaudePersistentSessionEnv,
} from "../src/claude/persistent-session-env";

function withTempDirs(run: (claudeDir: string, stateDir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "ocx-claude-persistent-env-"));
  const claudeDir = join(root, ".claude");
  const stateDir = join(root, ".opencodex");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  try {
    run(claudeDir, stateDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function readSettings(claudeDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8")) as Record<string, unknown>;
}

describe("Claude supervisor environment persistence", () => {
  test("selects only OCX provider keys and disables the settings-env stripping guard", () => {
    const selected = persistentClaudeEnv({
      PATH: "/tmp/private-bin",
      OPENCODEX_CLAUDE_REAL_COMMAND: "/usr/bin/claude",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:10100",
      ANTHROPIC_AUTH_TOKEN: "opencodex-proxy",
      ANTHROPIC_MODEL: "claude-ocx-opencode-free--deepseek-v4-flash-free",
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
    });

    expect(selected).toEqual({
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "0",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:10100",
      ANTHROPIC_AUTH_TOKEN: "opencodex-proxy",
      ANTHROPIC_MODEL: "claude-ocx-opencode-free--deepseek-v4-flash-free",
    });
    expect(selected.PATH).toBeUndefined();
    expect(selected.OPENCODEX_CLAUDE_REAL_COMMAND).toBeUndefined();
  });

  test("merges into settings.json without disturbing unrelated settings", () => {
    withTempDirs((claudeDir, stateDir) => {
      writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({
        theme: "dark",
        permissions: { allow: ["Bash(git status)"] },
        env: { KEEP_ME: "yes" },
      }, null, 2));

      const result = syncClaudePersistentSessionEnv({
        ANTHROPIC_BASE_URL: "http://127.0.0.1:10123",
        ANTHROPIC_AUTH_TOKEN: "opencodex-proxy",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      }, stateDir, claudeDir);

      expect(result.synced).toBe(true);
      const settings = readSettings(claudeDir);
      expect(settings.theme).toBe("dark");
      expect(settings.permissions).toEqual({ allow: ["Bash(git status)"] });
      expect(settings.env).toEqual({
        KEEP_ME: "yes",
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "0",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:10123",
        ANTHROPIC_AUTH_TOKEN: "opencodex-proxy",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      });
    });
  });

  test("restores the user's prior token when OCX switches to subscription mode", () => {
    withTempDirs((claudeDir, stateDir) => {
      writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: "user-token",
          CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
        },
      }, null, 2));

      expect(syncClaudePersistentSessionEnv({
        ANTHROPIC_BASE_URL: "http://127.0.0.1:10100",
        ANTHROPIC_AUTH_TOKEN: "opencodex-proxy",
      }, stateDir, claudeDir).synced).toBe(true);

      expect(syncClaudePersistentSessionEnv({
        ANTHROPIC_BASE_URL: "http://127.0.0.1:10101",
      }, stateDir, claudeDir).synced).toBe(true);

      const env = readSettings(claudeDir).env as Record<string, unknown>;
      expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:10101");
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe("user-token");
      expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("0");
    });
  });

  test("malformed Claude settings fail closed instead of replacing the file", () => {
    withTempDirs((claudeDir, stateDir) => {
      const path = join(claudeDir, "settings.json");
      writeFileSync(path, "{broken-json");

      const result = syncClaudePersistentSessionEnv({
        ANTHROPIC_BASE_URL: "http://127.0.0.1:10100",
      }, stateDir, claudeDir);

      expect(result.synced).toBe(false);
      expect(result.warning).toContain("could not be persisted");
      expect(readFileSync(path, "utf8")).toBe("{broken-json");
    });
  });
});
