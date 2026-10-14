import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, readlinkSync, readSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfigDir } from "../config";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { DesktopLibraryLockTimeoutError, withDesktopLibraryLock } from "./desktop-library-lock";

const DESKTOP_ID = "ocx-desktop.desktop";
const MIME_TYPE = "x-scheme-handler/ocx-desktop";
const MAX_FILE_BYTES = 32 * 1024;
const OWNER = "opencodex/claude-desktop-protocol";
const MAX_MIMEAPPS_BYTES = 256 * 1024;
const DISPATCH_MIN_INTERVAL_MS = 5_000;
const DISPATCH_STAMP = "claude-desktop-protocol-dispatch.stamp";
const DISPATCH_LOCK = "claude-desktop-protocol-dispatch.lock";
/** A claim holds its lock for microseconds; a longer wait means another dispatch is mid-claim. */
const DISPATCH_LOCK_WAIT_MS = 1_000;
const DISPATCH_LOCK_STALE_MS = 10_000;
/** Mimeapps sections in which `xdg-mime default` and desktop environments record handlers for us. */
const ASSOCIATION_SECTIONS = new Set(["Default Applications", "Added Associations"]);
/**
 * The exact shape this module generates. A Desktop entry that matches it but lost its ownership
 * state (for example after `ocx uninstall` deleted the config directory on an older release) is
 * provably ours, so it may be adopted or removed instead of wedging install and uninstall forever.
 */
const ORPHAN_ENTRY = /^\[Desktop Entry\]\nType=Application\nName=OCX Claude Desktop Sync\nNoDisplay=true\nTerminal=false\nExec=[^\n]+ %u\nMimeType=x-scheme-handler\/ocx-desktop;\nX-OCX-Protocol-Version=1\n$/;

export interface DesktopProtocolOptions {
  platform?: NodeJS.Platform;
  configDir?: string;
  dataHome?: string;
  /** Override for the XDG config home that holds mimeapps.list; defaults to the real one. */
  configHome?: string;
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
  status: "absent" | "installed" | "missing" | "orphaned" | "unchanged" | "repaired" | "skipped" | "uninstalled";
  desktopPath: string;
  statePath: string;
  /** uninstall: a default-handler association was removed from a mimeapps.list. */
  associationRemoved?: boolean;
  /** status: whether xdg-mime reports this handler as the default for the scheme (undefined = unknown). */
  registered?: boolean;
}

/**
 * The module declined to touch a file it cannot prove it owns: foreign, linked, oversized,
 * unversioned or fingerprint-mismatched. Callers treat this as "leave it alone", unlike an
 * I/O failure, which is a real error.
 */
export class DesktopProtocolRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopProtocolRefusal";
  }
}

/** The protocol handler is a Linux-only feature; any other platform is a usage error. */
function assertLinux(options: DesktopProtocolOptions): void {
  if ((options.platform ?? process.platform) !== "linux") {
    throw new Error("Claude Desktop protocol handling is supported only on Linux");
  }
}

/** Accept exactly `ocx-desktop://sync`; any other URI (or platform) is rejected before any work happens. */
export function assertClaudeDesktopProtocolUri(uri: string, options: DesktopProtocolOptions = {}): void {
  assertLinux(options);
  if (uri !== "ocx-desktop://sync") {
    throw new Error("Claude Desktop protocol accepts only the exact URI ocx-desktop://sync");
  }
}

/** XDG Base Directory: an unset, empty or relative XDG_DATA_HOME must be ignored, not rejected. */
function defaultDataHome(): string {
  const value = process.env.XDG_DATA_HOME;
  return value && isAbsolute(value) ? resolve(value) : join(homedir(), ".local", "share");
}

/** Require a normalized absolute path without control characters; anything else is refused outright. */
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

/** Render the exact Desktop Entry this module owns; the orphan matcher mirrors this template. */
function desktopEntry(runtimePath: string, cliPath: string): string {
  absolutePath(runtimePath);
  absolutePath(cliPath);
  if (runtimePath.includes("=") || runtimePath.includes("%")) {
    throw new Error("Desktop Exec runtime paths cannot contain equals signs or percent codes; use a runtime installed at a compatible absolute path");
  }
  const args = [runtimePath, cliPath, "claude", "desktop", "protocol", "dispatch"].map(execArgument);
  return `[Desktop Entry]\nType=Application\nName=OCX Claude Desktop Sync\nNoDisplay=true\nTerminal=false\nExec=${args.join(" ")} %u\nMimeType=${MIME_TYPE};\nX-OCX-Protocol-Version=1\n`;
}

/** SHA-256 of the generated entry text, recorded in the ownership state. */
function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Where the Desktop entry and the ownership state live for these options. */
function paths(options: DesktopProtocolOptions): { desktopPath: string; statePath: string } {
  assertLinux(options);
  const dataHome = absolutePath(options.dataHome ?? defaultDataHome());
  const configDir = absolutePath(options.configDir ?? getConfigDir());
  return {
    desktopPath: join(dataHome, "applications", DESKTOP_ID),
    statePath: join(configDir, "claude-desktop-protocol.json"),
  };
}

/** Refuse symbolic links and non-directories anywhere above `path`; missing ancestors are fine. */
function assertDirectory(path: string): void {
  let current = dirname(path);
  for (let depth = 0; ; depth++) {
    if (depth > 128) throw new Error("Claude Desktop protocol directory path is too deep");
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new DesktopProtocolRefusal("Claude Desktop protocol refuses symbolic links or non-directory ancestors");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dirname(current) === current) break;
    current = dirname(current);
  }
}

/** Read a small regular file we own without following links; null when it does not exist. */
function readRegular(path: string): string | null {
  assertDirectory(path);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new DesktopProtocolRefusal("Claude Desktop protocol refuses an unreadable or symbolic-link file");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES || (process.getuid && stat.uid !== process.getuid())) {
      throw new DesktopProtocolRefusal("Claude Desktop protocol refuses foreign, non-regular or oversized files");
    }
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    for (;;) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
      if (size > MAX_FILE_BYTES) throw new DesktopProtocolRefusal("Claude Desktop protocol file exceeds the size limit");
    }
    return buffer.subarray(0, size).toString("utf8");
  } finally { closeSync(fd); }
}

/**
 * Load the ownership state and Desktop entry. With `adoptOrphan`, an entry that matches the
 * generated template but has no state is returned as adoptable instead of refused.
 */
function inspect(options: DesktopProtocolOptions, adoptOrphan = false) {
  const locations = paths(options);
  const stateText = readRegular(locations.statePath);
  const desktopText = readRegular(locations.desktopPath);
  if (stateText === null) {
    if (desktopText !== null && adoptOrphan && ORPHAN_ENTRY.test(desktopText)) {
      return { ...locations, state: null, stateText, desktopText };
    }
    if (desktopText !== null) {
      throw new DesktopProtocolRefusal("Claude Desktop protocol file has no ownership state; inspect it manually rather than migrating or overwriting it");
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
    throw new DesktopProtocolRefusal("Claude Desktop protocol ownership state is invalid or unsupported; inspect it manually before reinstalling");
  }
  if (desktopText !== null && (fingerprint(desktopText) !== state.fingerprint
    || desktopText !== desktopEntry(state.runtimePath, state.cliPath))) {
    throw new DesktopProtocolRefusal("Claude Desktop protocol file differs from its owned fingerprint; refusing to overwrite or remove it");
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

/** The ownership state a fresh install would record for this runtime and CLI entrypoint. */
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

/**
 * No-clobber create: a hard link of the fully written temp file. Filesystems without hard links
 * (some FUSE/NFS/Termux setups) report EPERM/ENOTSUP, so fall back to an exclusive create.
 */
function createExclusive(temp: string, path: string, text: string): void {
  try {
    fs.linkSync(temp, path);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "ENOSYS") throw error;
  }
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let failure: unknown = null;
  try { writeFileSync(fd, text); } catch (error) { failure = error; }
  // A close can surface a delayed filesystem write error. Never retry a failed close:
  // it may already have released fd. Clean up this call's exclusive destination.
  try { fs.closeSync(fd); } catch (error) { if (failure === null) failure = error; }
  if (failure !== null) {
    try { unlinkSync(path); } catch { /* leave any residual for the ownership check to reject */ }
    throw failure;
  }
}

function atomicWrite(path: string, text: string, previous: string | null): void {
  assertDirectory(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  assertDirectory(path);
  const temp = join(dirname(path), `.ocx-protocol-${randomUUID()}.tmp`);
  writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
  try {
    if (readRegular(path) !== previous) throw new Error("Claude Desktop protocol files changed during installation; retry after inspection");
    if (previous === null) createExclusive(temp, path, text);
    else renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Write the entry and its state; roll the entry back if the state commit fails. True when anything changed. */
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

/** Run a helper binary with a timeout and bounded output; a missing binary throws ENOENT. */
function defaultExec(file: string, args: string[]): string {
  return execFileSync(file, args, {
    encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
}

/** XDG_CONFIG_HOME when it is absolute, otherwise `~/.config`. */
function defaultConfigHome(): string {
  const value = process.env.XDG_CONFIG_HOME;
  return value && isAbsolute(value) ? resolve(value) : join(homedir(), ".config");
}

/** Both locations `xdg-mime default` has used: $XDG_CONFIG_HOME and the legacy applications dir. */
function mimeappsPaths(options: DesktopProtocolOptions): string[] {
  const dataHome = absolutePath(options.dataHome ?? defaultDataHome());
  // A caller that isolates dataHome (tests, sandboxes) must not reach into the real config home.
  const configHome = options.configHome ?? (options.dataHome ? null : defaultConfigHome());
  return [
    ...(configHome ? [join(absolutePath(configHome), "mimeapps.list")] : []),
    join(dataHome, "applications", "mimeapps.list"),
  ];
}

/**
 * Drop only this handler's association from the sections that carry handler choices; every other
 * line, section and handler is preserved verbatim, including the file's own line endings.
 * `[Removed Associations]` is the user's deny list and is never edited.
 */
export function stripClaudeDesktopAssociation(text: string): string {
  const out: string[] = [];
  let section = "";
  // Odd entries are the captured separators, so CRLF files keep CRLF on every untouched line.
  const pieces = text.split(/(\r?\n)/);
  for (let index = 0; index < pieces.length; index += 2) {
    const line = pieces[index]!;
    const eol = pieces[index + 1] ?? "";
    const header = /^\s*\[([^\]]*)\]\s*$/.exec(line);
    if (header) {
      section = header[1]!;
    } else if (ASSOCIATION_SECTIONS.has(section)) {
      const eq = line.indexOf("=");
      if (eq > 0 && line.slice(0, eq).trim() === MIME_TYPE) {
        const kept = line.slice(eq + 1).split(";").map(item => item.trim()).filter(item => item && item !== DESKTOP_ID);
        if (kept.length === 0) continue;
        out.push(`${MIME_TYPE}=${kept.join(";")};${eol}`);
        continue;
      }
    }
    out.push(line + eol);
  }
  return out.join("");
}

/** Delete a file, treating "already gone" as success so a concurrent cleanup is not an error. */
function unlinkIfPresent(path: string): void {
  try { unlinkSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Rewrite one mimeapps.list without this handler. Symlinks, foreign owners and oversized files are
 * skipped, and the rewrite is abandoned if the file changed while it was being prepared.
 */
function rewriteMimeapps(path: string): boolean {
  try {
    const stat = lstatSync(path);
    // Dotfile setups symlink mimeapps.list; never write through a link or into someone else's file.
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MIMEAPPS_BYTES
      || (process.getuid && stat.uid !== process.getuid())) return false;
    const text = readFileSync(path, "utf8");
    const next = stripClaudeDesktopAssociation(text);
    if (next === text) return false;
    const temp = join(dirname(path), `.ocx-mimeapps-${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, next, { flag: "wx", mode: stat.mode & 0o777 });
      if (readFileSync(path, "utf8") !== text) return false;
      renameSync(temp, path);
      return true;
    } finally {
      try { unlinkSync(temp); } catch { /* already renamed or never created */ }
    }
  } catch {
    return false;
  }
}

function removeAssociation(options: DesktopProtocolOptions): boolean {
  let removed = false;
  for (const path of mimeappsPaths(options)) removed = rewriteMimeapps(path) || removed;
  return removed;
}

/**
 * Optional cache refresh. A caller-supplied `execCommand` owns every process this module may start
 * (fixtures, dry runs), so the extra housekeeping calls only run against the real system.
 */
function refreshDesktopDatabase(options: DesktopProtocolOptions, desktopPath: string): void {
  if (options.execCommand) return;
  try { defaultExec("update-desktop-database", [dirname(desktopPath)]); }
  catch { /* the entry works without the cache on modern desktops */ }
}

function queryRegistered(options: DesktopProtocolOptions): boolean | undefined {
  if (options.execCommand) return undefined;
  try {
    return defaultExec("xdg-mime", ["query", "default", MIME_TYPE]).trim() === DESKTOP_ID;
  } catch {
    return undefined;
  }
}

/**
 * Rate-limit link dispatches. Any web page can open ocx-desktop://sync, so a burst must collapse
 * into one sync. The age check and the stamp write run under a small cross-process lock, so two
 * simultaneous dispatches can never both claim the same window. Fails open: an unusable stamp
 * never blocks a legitimate sync, while a lock that stays busy means another dispatch is
 * mid-claim and this one is folded into it.
 */
export function claimClaudeDesktopProtocolDispatch(options: DesktopProtocolOptions = {}, now = Date.now()): boolean {
  let configDir: string;
  try { configDir = absolutePath(options.configDir ?? getConfigDir()); } catch { return true; }
  const stamp = join(configDir, DISPATCH_STAMP);
  try {
    return withDesktopLibraryLock(() => {
      try {
        const stat = lstatSync(stamp);
        if (stat.isSymbolicLink() || !stat.isFile()) return true;
        const age = now - stat.mtimeMs;
        if (age >= 0 && age < DISPATCH_MIN_INTERVAL_MS) return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
      }
      writeFileSync(stamp, String(now), { mode: 0o600 });
      try { recordOwnedConfigPath(configDir, stamp); } catch { /* bookkeeping must not block a sync */ }
      return true;
    }, {
      path: join(configDir, DISPATCH_LOCK),
      waitMs: DISPATCH_LOCK_WAIT_MS,
      staleMs: DISPATCH_LOCK_STALE_MS,
      recordOwned: true,
    });
  } catch (error) {
    return !(error instanceof DesktopLibraryLockTimeoutError);
  }
}

/** Report whether the handler is absent, installed, missing its entry, or an adoptable orphan. */
export function getClaudeDesktopProtocolStatus(options: DesktopProtocolOptions = {}): DesktopProtocolResult {
  const current = inspect(options, true);
  if (!current.state) {
    return { status: current.desktopText === null ? "absent" : "orphaned",
      desktopPath: current.desktopPath, statePath: current.statePath };
  }
  if (current.desktopText === null) {
    return { status: "missing", desktopPath: current.desktopPath, statePath: current.statePath };
  }
  const registered = queryRegistered(options);
  return { status: "installed", desktopPath: current.desktopPath, statePath: current.statePath,
    ...(registered === undefined ? {} : { registered }) };
}

/** Install or adopt the handler, then register it as the default for `ocx-desktop://`. */
export function installClaudeDesktopProtocol(options: DesktopProtocolOptions = {}): DesktopProtocolResult {
  const current = inspect(options, true);
  const changed = writeOwned(options, current);
  refreshDesktopDatabase(options, current.desktopPath);
  try {
    (options.execCommand ?? defaultExec)("xdg-mime", ["default", DESKTOP_ID, MIME_TYPE]);
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

/** Remove the handler, its ownership state, orphaned generated entries and the default-handler association. */
export function uninstallClaudeDesktopProtocol(options: DesktopProtocolOptions = {}): DesktopProtocolResult {
  const locations = paths(options);
  if (readRegular(locations.statePath) === null) {
    // No ownership state. A generated-shape entry is a recoverable orphan; anything else is not ours.
    const orphan = readRegular(locations.desktopPath);
    if (orphan !== null && !ORPHAN_ENTRY.test(orphan)) {
      throw new DesktopProtocolRefusal("Claude Desktop protocol file has no ownership state; inspect it manually rather than migrating or overwriting it");
    }
    if (orphan !== null) {
      if (readRegular(locations.desktopPath) !== orphan) throw new Error("Claude Desktop protocol file changed during uninstall");
      unlinkIfPresent(locations.desktopPath);
    }
    const associationRemoved = removeAssociation(options);
    if (orphan !== null) refreshDesktopDatabase(options, locations.desktopPath);
    return { status: orphan !== null || associationRemoved ? "uninstalled" : "absent", ...locations, associationRemoved };
  }
  const current = inspect(options);
  if (current.desktopText !== null) {
    if (readRegular(current.desktopPath) !== current.desktopText) throw new Error("Claude Desktop protocol file changed during uninstall");
    unlinkIfPresent(current.desktopPath);
  }
  if (readRegular(current.statePath) !== current.stateText) throw new Error("Claude Desktop protocol ownership changed during uninstall");
  // Another uninstall may have removed the state between the check above and now.
  unlinkIfPresent(current.statePath);
  // `xdg-mime default` persisted a default-handler line; leaving it would dangle after removal.
  const associationRemoved = removeAssociation(options);
  refreshDesktopDatabase(options, current.desktopPath);
  return { status: "uninstalled", desktopPath: current.desktopPath, statePath: current.statePath, associationRemoved };
}
