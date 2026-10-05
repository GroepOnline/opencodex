import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { renameAtomicFile } from "../config";
import { hardenSecretPath } from "../lib/windows-secret-acl";
import { resolveDesktop3pConfigLibraryPath } from "./desktop-3p";
import { resolveDataPlaneAdmissionToken } from "../lib/service-secrets";
import { realAdmissionToken } from "./auth-detect";

const MAX_LIBRARY_BYTES = 4 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
class DesktopSyncError extends Error {}

function assertLibraryDirectory(path: string): void {
  for (let current = resolve(path); ; current = dirname(current)) {
    try {
      const stat = lstatSync(current);
      if (process.platform === "darwin" && current === "/var" && stat.isSymbolicLink()
        && realpathSync(current) === "/private/var") continue;
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new DesktopSyncError("Claude Desktop sync refuses a non-directory or symbolic-link library path");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dirname(current) === current) break;
  }
}

export interface DesktopSyncOptions {
  automatic?: boolean;
  libraryPath?: string;
  settingsPath?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  runKeyHelper?: (command: string) => string;
  fileIO?: {
    harden?: (path: string) => void | { ok: boolean };
    atomicWrite?: (path: string, content: string | Buffer) => void;
  };
}

export type DesktopSyncResult = { status: "synced" | "unchanged" | "skipped"; models: number };

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertRegularFile(path: string): void {
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LIBRARY_BYTES) {
    throw new DesktopSyncError("Claude Desktop sync refuses a non-regular or oversized configuration file");
  }
}

function readObject(path: string): Record<string, unknown> {
  assertRegularFile(path);
  if (!existsSync(path)) return {};
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!object(value)) throw new DesktopSyncError("Claude Desktop sync configuration has an invalid shape");
  return value;
}

/** Mirror the applied library over the existing client gateway; never stop either client. */
export async function syncClaudeDesktopLibrary(options: DesktopSyncOptions = {}): Promise<DesktopSyncResult> {
  try { return await syncLibrary(options); } catch (error) {
    // JSON, transport and filesystem exceptions may embed secret-bearing input or paths.
    if (error instanceof DesktopSyncError) throw error;
    throw new DesktopSyncError("Claude Desktop sync failed; local configuration was not confirmed updated");
  }
}

async function syncLibrary(options: DesktopSyncOptions): Promise<DesktopSyncResult> {
  const env = options.env ?? process.env;
  const library = options.libraryPath ?? resolveDesktop3pConfigLibraryPath();
  assertLibraryDirectory(library);
  const metaPath = join(library, "_meta.json");
  assertRegularFile(metaPath);
  const originalMeta = existsSync(metaPath) ? readFileSync(metaPath, "utf8") : null;
  const localMeta: unknown = originalMeta === null ? {} : JSON.parse(originalMeta);
  if (!object(localMeta)) throw new DesktopSyncError("Claude Desktop sync configuration has an invalid shape");
  const entries = Array.isArray(localMeta.entries) ? localMeta.entries.filter(object) : [];
  if (options.automatic && !entries.some(entry => entry.name === "opencodex")) {
    return { status: "skipped", models: 0 };
  }
  const settings = readObject(options.settingsPath ?? join(homedir(), ".claude", "settings.json"));
  const settingsEnv = object(settings.env) ? settings.env : {};
  const rawBase = env.ANTHROPIC_BASE_URL ?? settingsEnv.ANTHROPIC_BASE_URL;
  if (typeof rawBase !== "string") {
    if (options.automatic) return { status: "skipped", models: 0 };
    throw new DesktopSyncError("Claude Desktop sync requires the configured Claude Code gateway");
  }
  const base = new URL(rawBase);
  // Credentials only cross the configured protected local tunnel, never an arbitrary remote host.
  if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)
    || !["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash
    || !["", "/", "/v1", "/v1/"].includes(base.pathname)) {
    throw new DesktopSyncError("Claude Desktop sync requires a loopback OCX gateway or protected local tunnel");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const health = await fetchImpl(`${base.origin}/healthz`, { redirect: "error", signal: AbortSignal.timeout(3000) });
  if (!health.ok) throw new DesktopSyncError(`OCX health probe returned HTTP ${health.status}`);
  const identity = await readBoundedJson(health, 64 * 1024);
  if (!object(identity) || identity.service !== "opencodex" || identity.status !== "ok") {
    throw new DesktopSyncError("Claude Desktop gateway did not identify as OCX");
  }
  const admissionEnv = { ...env, OPENCODEX_API_AUTH_TOKEN: realAdmissionToken(env.OPENCODEX_API_AUTH_TOKEN) ?? undefined };
  let token = [env.OPENCODEX_API_KEY, resolveDataPlaneAdmissionToken(admissionEnv), env.ANTHROPIC_AUTH_TOKEN,
    env.ANTHROPIC_API_KEY, settingsEnv.ANTHROPIC_AUTH_TOKEN, settingsEnv.ANTHROPIC_API_KEY]
    .map(value => typeof value === "string" ? realAdmissionToken(value) : null).find(Boolean);
  if (!token && typeof settings.apiKeyHelper === "string") {
    try {
      token = (options.runKeyHelper ?? (command => execSync(command, {
        encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024, stdio: ["ignore", "pipe", "pipe"],
      })))(settings.apiKeyHelper).trim();
    } catch {
      throw new DesktopSyncError("Claude Code apiKeyHelper failed during Desktop sync");
    }
  }
  if (typeof token !== "string" || !realAdmissionToken(token) || /[\r\n]/.test(token)) {
    throw new DesktopSyncError("Claude Desktop sync has no valid data-plane admission credential");
  }
  const response = await fetchImpl(`${base.origin}/v1/claude-desktop-3p-library`, {
    headers: { authorization: `Bearer ${token.trim()}`, accept: "application/json" },
    redirect: "error", signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new DesktopSyncError(`Claude Desktop library returned HTTP ${response.status}`);
  const payload = await readBoundedJson(response, MAX_LIBRARY_BYTES);
  if (!object(payload) || payload.ok !== true || typeof payload.appliedId !== "string"
    || !SAFE_ID.test(payload.appliedId) || !object(payload.config) || !object(payload.meta)
    || payload.meta.appliedId !== payload.appliedId || !Array.isArray(payload.meta.entries)
    || !payload.meta.entries.some(entry => object(entry) && entry.name === "opencodex" && entry.id === payload.appliedId)) {
    throw new DesktopSyncError("Claude Desktop library has an invalid applied profile");
  }
  return writeLibrary(library, metaPath, localMeta, entries, originalMeta, payload.appliedId, payload.config, base.origin, options.fileIO);
}

async function readBoundedJson(response: Response, limit: number): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new DesktopSyncError("Claude Desktop library exceeds the size limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new DesktopSyncError("Claude Desktop library response is empty");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new DesktopSyncError("Claude Desktop library exceeds the size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function protectFile(path: string): void {
  chmodSync(path, 0o600);
  if (!hardenSecretPath(path, { required: true }).ok) {
    throw new DesktopSyncError("Claude Desktop sync could not protect a configuration file");
  }
}

function writeProtectedFile(path: string, content: string | Buffer, harden: (path: string) => void): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    harden(path);
    writeFileSync(fd, content);
  } catch (error) {
    try { ftruncateSync(fd, 0); } catch { /* removal is attempted after closing the handle */ }
    closeSync(fd);
    try { unlinkSync(path); } catch { /* hardening failed before any secret bytes were written */ }
    throw error;
  }
  closeSync(fd);
}

function writeProtectedAtomic(path: string, content: string | Buffer, harden: (path: string) => void): void {
  const temp = `${path}.ocx.${process.pid}.${randomUUID()}.tmp`;
  writeProtectedFile(temp, content, harden);
  try { renameAtomicFile(temp, path); } catch (error) {
    try { truncateSync(temp, 0); } catch { /* the temporary file was protected before writing */ }
    try { unlinkSync(temp); } catch { /* preserve protected residual rather than replacing the destination */ }
    throw error;
  }
}

function writeLibrary(
  library: string, metaPath: string, localMeta: Record<string, unknown>,
  entries: Record<string, unknown>[], originalMeta: string | null,
  appliedId: string, remoteConfig: Record<string, unknown>, origin: string,
  fileIO: DesktopSyncOptions["fileIO"],
): DesktopSyncResult {
  assertLibraryDirectory(library);
  const collision = entries.find(entry => entry.id === appliedId && entry.name !== "opencodex");
  if (collision) throw new DesktopSyncError("Claude Desktop profile id conflicts with a local profile");
  const config: Record<string, unknown> = { ...remoteConfig, inferenceGatewayBaseUrl: origin };
  const meta = { ...localMeta, entries: [...entries.filter(entry => entry.name !== "opencodex"),
    { id: appliedId, name: "opencodex" }], appliedId };
  const configPath = join(library, `${appliedId}.json`);
  assertRegularFile(configPath);
  if (existsSync(configPath) && !entries.some(entry => entry.id === appliedId && entry.name === "opencodex")) {
    throw new DesktopSyncError("Claude Desktop profile id conflicts with an unregistered local profile");
  }
  assertRegularFile(metaPath);
  if ((existsSync(metaPath) ? readFileSync(metaPath, "utf8") : null) !== originalMeta) {
    throw new DesktopSyncError("Claude Desktop library changed during sync; retry without closing any client");
  }
  const configText = JSON.stringify(config, null, 2) + "\n";
  const metaText = JSON.stringify(meta, null, 2) + "\n";
  const models = Array.isArray(config.inferenceModels) ? config.inferenceModels.length : 0;
  const originalConfig = existsSync(configPath) ? readFileSync(configPath) : null;
  if (originalConfig?.equals(Buffer.from(configText)) && originalMeta === metaText) {
    return { status: "unchanged", models };
  }
  const harden = (path: string): void => {
    const result = (fileIO?.harden ?? protectFile)(path);
    if (result && !result.ok) throw new DesktopSyncError("Claude Desktop sync could not protect a configuration file");
  };
  const atomicWrite = fileIO?.atomicWrite ?? ((path, content) => writeProtectedAtomic(path, content, harden));
  mkdirSync(library, { recursive: true, mode: 0o700 });
  for (const [path, previous] of [[configPath, originalConfig], [metaPath, originalMeta === null ? null : Buffer.from(originalMeta)]] as const) {
    if (previous === null) continue;
    const digest = createHash("sha256").update(previous).digest("hex").slice(0, 16);
    const backup = `${path}.before-sync-${digest}.bak`;
    assertRegularFile(backup);
    if (existsSync(backup)) {
      if (!readFileSync(backup).equals(previous)) throw new DesktopSyncError("Claude Desktop sync backup conflicts with existing data");
      harden(backup);
    } else {
      writeProtectedFile(backup, previous, harden);
    }
  }
  atomicWrite(configPath, configText);
  const writtenConfig = lstatSync(configPath);
  try { atomicWrite(metaPath, metaText); } catch {
    try {
      assertRegularFile(configPath);
      const current = lstatSync(configPath);
      if (current.dev !== writtenConfig.dev || current.ino !== writtenConfig.ino
        || !readFileSync(configPath).equals(Buffer.from(configText))) throw new Error("Configuration changed during rollback");
      if (originalConfig !== null) atomicWrite(configPath, originalConfig);
      else unlinkSync(configPath);
    } catch {
      throw new DesktopSyncError("Claude Desktop metadata update failed and configuration rollback failed; protected backups are available");
    }
    throw new DesktopSyncError("Claude Desktop metadata update failed; configuration was rolled back");
  }
  return { status: "synced", models };
}
