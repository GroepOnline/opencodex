/**
 * Regression coverage for the `cmdClaude` → `commandInvocation`/`spawn` wiring:
 * the recursive-launch command and env must be the ones the child process
 * actually receives, not the raw process env (review on PR #53).
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as agentsInject from "../src/claude/agents-inject";
import * as gatewayCache from "../src/claude/gateway-cache";
import * as configModule from "../src/config";
import * as proxyLiveness from "../src/server/proxy-liveness";
import type { OcxConfig } from "../src/types";

const root = mkdtempSync(join(tmpdir(), "ocx-claude-spawn-wiring-"));
const binDir = join(root, "bin");
const configDir = join(root, "home");
mkdirSync(binDir, { recursive: true });
const isWindows = process.platform === "win32";
const fakeClaude = join(binDir, isWindows ? "claude.CMD" : "claude");
writeFileSync(
  fakeClaude,
  isWindows ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
  { mode: 0o755 },
);

const PROXY_PORT = 10142;

type SpawnCall = { file: string; args: string[]; options: childProcess.SpawnOptions };
const spawnCalls: SpawnCall[] = [];
const spawnMock = mock((file: string, args: readonly string[], options: childProcess.SpawnOptions) => {
  spawnCalls.push({ file, args: [...args], options });
  const child = new EventEmitter();
  queueMicrotask(() => child.emit("exit", 0, null));
  return child as unknown as childProcess.ChildProcess;
});

mock.module("node:child_process", () => ({ ...childProcess, spawn: spawnMock }));
mock.module("../src/config", () => ({
  ...configModule,
  loadConfig: (): OcxConfig => ({ port: PROXY_PORT } as OcxConfig),
  getConfigDir: () => configDir,
}));
mock.module("../src/server/proxy-liveness", () => ({
  ...proxyLiveness,
  findLiveProxy: async () => ({ pid: null, port: PROXY_PORT, source: "config" as const }),
}));
mock.module("../src/claude/gateway-cache", () => ({
  ...gatewayCache,
  refreshGatewayModelCacheFromProxy: async () => join(root, "gateway-cache.json"),
}));
mock.module("../src/claude/agents-inject", () => ({
  ...agentsInject,
  injectClaudeAgentDefs: () => 1,
}));

const { cmdClaude } = await import("../src/cli/claude");

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("cmdClaude spawn wiring", () => {
  test("forwards the recursive-launch command and env through commandInvocation into spawn", async () => {
    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === "path") ?? "PATH";
    const saved: Record<string, string | undefined> = {
      [pathKey]: process.env[pathKey],
      PATHEXT: process.env.PATHEXT,
      OPENCODEX_CLAUDE_REAL_COMMAND: process.env.OPENCODEX_CLAUDE_REAL_COMMAND,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    };
    process.env[pathKey] = binDir;
    if (isWindows) process.env.PATHEXT = ".CMD";
    delete process.env.OPENCODEX_CLAUDE_REAL_COMMAND;
    delete process.env.ANTHROPIC_BASE_URL;
    try {
      const code = await cmdClaude(["--model", "wiring-check"]);

      expect(code).toBe(0);
      expect(spawnCalls.length).toBe(1);
      const { file, args, options } = spawnCalls[0]!;
      const commandLine = [file, ...args].join(" ");
      // recursiveLaunch.command reached commandInvocation and its output reached spawn.
      if (isWindows) {
        // win32 routes `.cmd` launchers through ComSpec with the resolved path inline.
        expect(commandLine).toContain("claude.CMD");
      } else {
        expect(file).toBe(fakeClaude);
        expect(args).toEqual(["--model", "wiring-check"]);
      }
      expect(commandLine).toContain("wiring-check");
      // recursiveLaunch.env — not the raw process env — is what the child receives.
      const spawnedEnv = options.env as Record<string, string | undefined>;
      expect(spawnedEnv.OPENCODEX_CLAUDE_REAL_COMMAND).toBe(fakeClaude);
      expect(spawnedEnv.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${PROXY_PORT}`);
      const spawnedPathKey = Object.keys(spawnedEnv).find(key => key.toLowerCase() === "path") ?? "PATH";
      const firstPathEntry = (spawnedEnv[spawnedPathKey] ?? "").split(isWindows ? ";" : ":")[0]!;
      expect(dirname(firstPathEntry)).toBe(join(configDir, "claude-launcher"));
      expect(options.stdio).toBe("inherit");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
