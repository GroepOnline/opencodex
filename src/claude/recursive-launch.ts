import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { posix, win32 } from "node:path";

export interface RecursiveClaudeEnv {
  [key: string]: string | undefined;
}

export interface RecursiveClaudeLaunchDeps {
  platform?: NodeJS.Platform;
  configDir: string;
  runtimePath: string;
  entryPath: string;
  exists?: (path: string) => boolean;
  isExecutable?: (path: string) => boolean;
  writeShim?: (path: string, content: string, platform: NodeJS.Platform) => void;
}

export interface RecursiveClaudeLaunch {
  command: string;
  env: RecursiveClaudeEnv;
  shimPath: string | null;
  warning?: string;
}

const REAL_COMMAND_ENV = "OPENCODEX_CLAUDE_REAL_COMMAND";

function pathVariableName(env: RecursiveClaudeEnv): string {
  return Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH";
}

function isExecutableDefault(path: string, platform: NodeJS.Platform): boolean {
  if (!existsSync(path)) return false;
  if (platform === "win32") return true;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the native Claude launcher before the OCX shim is added to PATH. */
export function resolveNativeClaudeCommand(
  env: RecursiveClaudeEnv,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
  isExecutable: (path: string) => boolean = path => isExecutableDefault(path, platform),
): string | null {
  const pinned = env[REAL_COMMAND_ENV]?.trim();
  if (pinned && exists(pinned) && isExecutable(pinned)) return pinned;

  const pathKey = pathVariableName(env);
  const delimiter = platform === "win32" ? win32.delimiter : posix.delimiter;
  const dirs = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
  if (platform === "win32") {
    const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
    for (const dir of dirs) {
      for (const extension of extensions) {
        const candidate = win32.join(dir, `claude${extension}`);
        if (exists(candidate) && isExecutable(candidate)) return candidate;
      }
    }
    return null;
  }

  for (const dir of dirs) {
    const candidate = posix.join(dir, "claude");
    if (exists(candidate) && isExecutable(candidate)) return candidate;
  }
  return null;
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quoteCmdValue(value: string): string {
  // Percent expansion happens even inside quoted SET values and command tokens.
  return value.replaceAll("%", "%%").replaceAll("^", "^^");
}

/** The shim contains paths only; gateway URLs and auth tokens remain process-local. */
export function renderRecursiveClaudeShim(
  platform: NodeJS.Platform,
  realCommand: string,
  runtimePath: string,
  entryPath: string,
): string {
  if (platform === "win32") {
    return [
      "@echo off",
      "setlocal",
      `set "${REAL_COMMAND_ENV}=${quoteCmdValue(realCommand)}"`,
      `"${quoteCmdValue(runtimePath)}" "${quoteCmdValue(entryPath)}" claude %*`,
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n");
  }

  return [
    "#!/bin/sh",
    "set -eu",
    `export ${REAL_COMMAND_ENV}=${quotePosix(realCommand)}`,
    `exec ${quotePosix(runtimePath)} ${quotePosix(entryPath)} claude "$@"`,
    "",
  ].join("\n");
}

function writeShimAtomic(path: string, content: string, platform: NodeJS.Platform): void {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, content, { encoding: "utf8", mode: 0o700 });
  renameSync(temp, path);
  if (platform !== "win32") chmodSync(path, 0o700);
}

function prependShimToPath(env: RecursiveClaudeEnv, shimDir: string, platform: NodeJS.Platform): void {
  const pathKey = pathVariableName(env);
  const delimiter = platform === "win32" ? win32.delimiter : posix.delimiter;
  const current = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
  env[pathKey] = [shimDir, ...current.filter(entry => entry !== shimDir)].join(delimiter);
}

/**
 * Stable, non-secret identity for one OCX + Claude installation tuple. Shims for two
 * concurrently active installations sharing OPENCODEX_HOME must never overwrite each
 * other: an earlier session keeps its own directory at the front of PATH.
 */
function installationKey(
  platform: NodeJS.Platform,
  realCommand: string,
  runtimePath: string,
  entryPath: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([platform, realCommand, runtimePath, entryPath]))
    .digest("hex")
    .slice(0, 20);
}

/**
 * Install a lightweight `claude` shim for descendants of `ocx claude`.
 *
 * Claude Code may deliberately remove provider auth variables from tool/child process
 * environments. A descendant that starts a fresh `claude` CLI would then fall back to
 * its own login state and report "Not logged in". The shim re-enters `ocx claude`, which
 * reconstructs the complete gateway environment from current config. No token is
 * written to disk; the generated launcher stores only executable paths.
 */
export function prepareRecursiveClaudeLaunch(
  base: RecursiveClaudeEnv,
  deps: RecursiveClaudeLaunchDeps,
): RecursiveClaudeLaunch {
  const platform = deps.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : posix;
  const exists = deps.exists ?? existsSync;
  const isExecutable = deps.isExecutable ?? (path => isExecutableDefault(path, platform));
  const realCommand = resolveNativeClaudeCommand(base, platform, exists, isExecutable);
  if (!realCommand) {
    return { command: "claude", env: { ...base }, shimPath: null };
  }

  const env: RecursiveClaudeEnv = { ...base, [REAL_COMMAND_ENV]: realCommand };
  const key = installationKey(platform, realCommand, deps.runtimePath, deps.entryPath);
  const shimDir = pathApi.join(deps.configDir, "claude-launcher", key);
  const shimPath = pathApi.join(shimDir, platform === "win32" ? "claude.cmd" : "claude");
  try {
    mkdirSync(shimDir, { recursive: true, mode: 0o700 });
    const content = renderRecursiveClaudeShim(platform, realCommand, deps.runtimePath, deps.entryPath);
    (deps.writeShim ?? writeShimAtomic)(shimPath, content, platform);
    prependShimToPath(env, shimDir, platform);
    return { command: realCommand, env, shimPath };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      command: realCommand,
      env,
      shimPath: null,
      warning: `Recursive Claude launcher could not be installed: ${detail}`,
    };
  }
}
