import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync,
  readlinkSync, readSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfigDir } from "../config";

const DESKTOP_ID = "ocx-desktop.desktop";
const MIME_TYPE = "x-scheme-handler/ocx-desktop";
const MAX_FILE_BYTES = 32 * 1024;
const OWNER = "opencodex/claude-desktop-protocol";

export interface DesktopProtocolOptions {
  platform?: NodeJS.Platform;
  configDir?: string;
  dataHome?: string;
  runtimePath?: string;
  cliPath?: string;
  execCommand?: (file: string, args: string[]) => string | void;
}

interface ProtocolState {
  version: 1;
  owner: typeof OWNER;
  desktopPath: string;
  runtimePath: string;
  cliPath: string;
  fingerprint: string;
}

export interface DesktopProtocolResult {
  status: "absent" | "installed" | "missing" | "unchanged" | "repaired" | "skipped" | "uninstalled";
  desktopPath: string;
  statePath: string;
}

function assertLinux(options: DesktopProtocolOptions): void {
  if ((options.platform ?? process.platform) !== "linux") {
    throw new Error("Claude Desktop protocol handling is supported only on Linux");
  }
}

export function assertClaudeDesktopProtocolUri(uri: string, options: DesktopProtocolOptions = {}): void {
  assertLinux(options);
  if (uri !== "ocx-desktop://sync") {
    throw new Error("Claude Desktop protocol accepts only the exact URI ocx-desktop://sync");
  }
}

function absolutePath(value: string): string {
  if (!isAbsolute(value) || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) || resolve(value) !== value) {
    throw new Error("Claude Desktop protocol requires normalized absolute paths without control characters");
  }
  return value;
}

/** Desktop Entry string escaping is applied after Exec argument quoting, not shell quoting. */
function execArgument(value: string): string {
  const escaped = value.replace(/[\\"`$%]/g, char => {
    if (char === "%") return "%%";
    if (char === "\\") return "\\".repeat(4);
    return "\\".repeat(2) + char;
  });
  return `"${escaped}"`;
}

function desktopEntry(runtimePath: string, cliPath: string): string {
  absolutePath(runtimePath);
  absolutePath(cliPath);
  if (runtimePath.includes("=") || runtimePath.includes("%")) {
    throw new Error("Desktop Exec runtime paths cannot contain equals signs or percent codes; use a runtime installed at a compatible absolute path");
  }
  const args = [runtimePath, cliPath, "claude", "desktop", "protocol", "dispatch"].map(execArgument);
  return `[Desktop Entry]\nType=Application\nName=OCX Claude Desktop Sync\nNoDisplay=true\nTerminal=false\nExec=${args.join(" ")} %u\nMimeType=${MIME_TYPE};\nX-OCX-Protocol-Version=1\n`;
}

function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function paths(options: DesktopProtocolOptions): { desktopPath: string; statePath: string } {
  assertLinux(options);
  const dataHome = absolutePath(options.dataHome ?? process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"));
  const configDir = absolutePath(options.configDir ?? getConfigDir());
  return {
    desktopPath: join(dataHome, "applications", DESKTOP_ID),
    statePath: join(configDir, "claude-desktop-protocol.json"),
  };
}

function assertDirectory(path: string): void {
  let current = dirname(path);
  for (let depth = 0; ; depth++) {
    if (depth > 128) throw new Error("Claude Desktop protocol directory path is too deep");
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Claude Desktop protocol refuses symbolic links or non-directory ancestors");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dirname(current) === current) break;
    current = dirname(current);
  }
}

function readRegular(path: string): string | null {
  assertDirectory(path);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Claude Desktop protocol refuses an unreadable or symbolic-link file");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error("Claude Desktop protocol refuses foreign, non-regular or oversized files");
    }
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    for (;;) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
      if (size > MAX_FILE_BYTES) throw new Error("Claude Desktop protocol file exceeds the size limit");
    }
    return buffer.subarray(0, size).toString("utf8");
  } finally { closeSync(fd); }
}

function inspect(options: DesktopProtocolOptions) {
  const locations = paths(options);
  const stateText = readRegular(locations.statePath);
  const desktopText = readRegular(locations.desktopPath);
  if (stateText === null) {
    if (desktopText !== null) {
      throw new Error("Claude Desktop protocol file has no ownership state; inspect it manually rather than migrating or overwriting it");
    }
    return { ...locations, state: null, stateText, desktopText };
  }
  let state: ProtocolState;
  try {
    const value = JSON.parse(stateText);
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "cliPath,desktopPath,fingerprint,owner,runtimePath,version"
      || value.version !== 1 || value.owner !== OWNER || value.desktopPath !== locations.desktopPath
      || typeof value.runtimePath !== "string" || typeof value.cliPath !== "string"
      || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)
      || fingerprint(desktopEntry(value.runtimePath, value.cliPath)) !== value.fingerprint) throw new Error();
    state = value;
  } catch {
    throw new Error("Claude Desktop protocol ownership state is invalid or unsupported; inspect it manually before reinstalling");
  }
  if (desktopText !== null && (fingerprint(desktopText) !== state.fingerprint
    || desktopText !== desktopEntry(state.runtimePath, state.cliPath))) {
    throw new Error("Claude Desktop protocol file differs from its owned fingerprint; refusing to overwrite or remove it");
  }
  return { ...locations, state, stateText, desktopText };
}

// Bun realpath currently misinterprets literal Linux backslashes. Resolve symlinks as POSIX paths.
function runtimeTarget(path: string): string {
  let target = absolutePath(path);
  for (let links = 0; links <= 40; links++) {
    const parts = target.slice(1).split("/");
    let current = "/";
    let redirected = false;
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]!);
      if (!lstatSync(current).isSymbolicLink()) continue;
      target = absolutePath(resolve(dirname(current), readlinkSync(current), ...parts.slice(index + 1)));
      redirected = true;
      break;
    }
    if (!redirected) return target;
  }
  throw new Error("Claude Desktop protocol runtime or CLI has too many symbolic links");
}

function desiredState(options: DesktopProtocolOptions, desktopPath: string): ProtocolState {
  const runtimePath = runtimeTarget(options.runtimePath ?? process.execPath);
  const cliPath = runtimeTarget(options.cliPath ?? fileURLToPath(new URL("../cli/index.ts", import.meta.url)));
  if (!lstatSync(runtimePath).isFile() || !lstatSync(cliPath).isFile()
    || !(lstatSync(runtimePath).mode & 0o111)) {
    throw new Error("Claude Desktop protocol requires an executable runtime and a regular CLI entrypoint");
  }
  return { version: 1, owner: OWNER, desktopPath, runtimePath, cliPath,
    fingerprint: fingerprint(desktopEntry(runtimePath, cliPath)) };
}

function atomicWrite(path: string, text: string, previous: string | null): void {
  assertDirectory(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  assertDirectory(path);
  const temp = join(dirname(path), `.ocx-protocol-${randomUUID()}.tmp`);
  writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
  try {
    if (readRegular(path) !== previous) throw new Error("Claude Desktop protocol files changed during installation; retry after inspection");
    if (previous === null) linkSync(temp, path);
    else renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function writeOwned(options: DesktopProtocolOptions, current: ReturnType<typeof inspect>): boolean {
  const state = desiredState(options, current.desktopPath);
  const desktopText = desktopEntry(state.runtimePath, state.cliPath);
  const stateText = JSON.stringify(state, null, 2) + "\n";
  if (current.desktopText === desktopText && current.stateText === stateText) return false;
  const desktopChanged = current.desktopText !== desktopText;
  if (desktopChanged) atomicWrite(current.desktopPath, desktopText, current.desktopText);
  const writtenDesktop = desktopChanged ? lstatSync(current.desktopPath) : null;
  try {
    if (current.stateText !== stateText) atomicWrite(current.statePath, stateText, current.stateText);
  } catch {
    if (!writtenDesktop) {
      throw new Error("Claude Desktop protocol ownership state commit failed; the Desktop entry was not changed");
    }
    try {
      const latest = lstatSync(current.desktopPath);
      if (latest.dev !== writtenDesktop.dev || latest.ino !== writtenDesktop.ino
        || readRegular(current.desktopPath) !== desktopText) {
        throw new Error("Desktop entry no longer matches this installation attempt");
      }
      if (current.desktopText === null) unlinkSync(current.desktopPath);
      else atomicWrite(current.desktopPath, current.desktopText, desktopText);
    } catch {
      throw new Error("Claude Desktop protocol ownership state commit failed and Desktop entry rollback failed; inspect both owned files manually before retrying");
    }
    throw new Error("Claude Desktop protocol ownership state commit failed; this attempt's Desktop entry change was rolled back");
  }
  return true;
}

export function getClaudeDesktopProtocolStatus(options: DesktopProtocolOptions = {}): DesktopProtocolResult {
  const current = inspect(options);
  return { status: !current.state ? "absent" : current.desktopText === null ? "missing" : "installed",
    desktopPath: current.desktopPath, statePath: current.statePath };
}

export function installClaudeDesktopProtocol(options: DesktopProtocolOptions = {}): DesktopProtocolResult {
  const current = inspect(options);
  const changed = writeOwned(options, current);
  try {
    (options.execCommand ?? ((file, args) => execFileSync(file, args, {
      encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024, stdio: ["ignore", "pipe", "pipe"],
    })))("xdg-mime", ["default", DESKTOP_ID, MIME_TYPE]);
  } catch {
    throw new Error("Claude Desktop protocol files are owned, but XDG registration failed; retry ocx claude desktop protocol install");
  }
  return { status: changed ? "installed" : "unchanged", desktopPath: current.desktopPath, statePath: current.statePath };
}

/** Package updates may refresh only this versioned, fingerprint-proven installation. */
export function repairClaudeDesktopProtocol(options: DesktopProtocolOptions = {}): DesktopProtocolResult {
  const current = inspect(options);
  if (!current.state) return { status: "skipped", desktopPath: current.desktopPath, statePath: current.statePath };
  const changed = writeOwned(options, current);
  return { status: changed ? "repaired" : "unchanged", desktopPath: current.desktopPath, statePath: current.statePath };
}

export function uninstallClaudeDesktopProtocol(options: DesktopProtocolOptions = {}): DesktopProtocolResult {
  const current = inspect(options);
  if (!current.state) return { status: "absent", desktopPath: current.desktopPath, statePath: current.statePath };
  if (current.desktopText !== null) {
    if (readRegular(current.desktopPath) !== current.desktopText) throw new Error("Claude Desktop protocol file changed during uninstall");
    unlinkSync(current.desktopPath);
  }
  if (readRegular(current.statePath) !== current.stateText) throw new Error("Claude Desktop protocol ownership changed during uninstall");
  unlinkSync(current.statePath);
  return { status: "uninstalled", desktopPath: current.desktopPath, statePath: current.statePath };
}
