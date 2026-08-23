#!/usr/bin/env bun
/**
 * Copy the OCX home state files into a timestamped directory with a sha256
 * manifest. Default destination: `$OPENCODEX_HOME/backups/<iso>`.
 *
 * Copies config.json as-is. Inline provider API keys in that file are therefore
 * present in the backup — treat every backup as secret-bearing.
 *
 * Missing optional files (auth.json, codex-accounts.json, account-runtime.json)
 * are recorded as absent and do not fail the run. That is the live Azure case.
 *
 * Usage:
 *   bun scripts/backup-state.ts
 *   bun scripts/backup-state.ts --home <dir> --dest <dir>
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getConfigDir } from "../src/config";
import { redactSecrets, redactUserPath } from "../src/lib/redact";

export const BACKUP_MANIFEST_NAME = "backup.manifest.json";
export const BACKUP_STATE_FILES = [
  "config.json",
  "usage.jsonl",
  "auth.json",
  "codex-accounts.json",
  "account-runtime.json",
] as const;

export type BackupStateFile = (typeof BACKUP_STATE_FILES)[number];

export interface BackupFileFingerprint {
  name: BackupStateFile;
  present: boolean;
  size: number | null;
  sha256: string | null;
}

export interface BackupManifest {
  version: 1;
  createdAt: string;
  sourceDir: string;
  destDir: string;
  files: BackupFileFingerprint[];
}

export interface BackupOptions {
  home: string;
  dest?: string;
  now?: Date;
}

export interface BackupResult {
  dest: string;
  manifest: BackupManifest;
  copied: BackupStateFile[];
  absent: BackupStateFile[];
}

export class BackupError extends Error {
  constructor(message: string, readonly exitCode = 2) {
    super(message);
    this.name = "BackupError";
  }
}

function sha256Bytes(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function backupIsoStamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function defaultBackupDest(home: string, now = new Date()): string {
  return join(resolve(home), "backups", backupIsoStamp(now));
}

export function fingerprintBackupFile(dir: string, name: BackupStateFile): BackupFileFingerprint {
  const path = join(dir, name);
  if (!existsSync(path) || !statSync(path).isFile()) {
    return { name, present: false, size: null, sha256: null };
  }
  const bytes = readFileSync(path);
  return { name, present: true, size: bytes.byteLength, sha256: sha256Bytes(bytes) };
}

export function formatBackupReport(result: BackupResult): string {
  const lines = [
    `backed up ${result.copied.length} file(s) dest=${redactUserPath(result.dest)}`,
    `source=${redactUserPath(result.manifest.sourceDir)} createdAt=${result.manifest.createdAt}`,
  ];
  for (const file of result.manifest.files) {
    if (file.present) {
      lines.push(`${file.name} present size=${file.size} sha256=${file.sha256}`);
    } else {
      lines.push(`${file.name} absent`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function takeOption(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) throw new BackupError(`${flag} requires a value`);
  args.splice(at, 2);
  return value;
}

export function parseBackupArgs(argv: string[]): BackupOptions {
  const args = [...argv];
  const options: BackupOptions = {
    home: takeOption(args, "--home") ?? process.env.OPENCODEX_HOME ?? getConfigDir(),
    dest: takeOption(args, "--dest"),
  };
  if (args.length) throw new BackupError(`unexpected argument(s): ${args.join(" ")}`);
  return options;
}

export function backupState(options: BackupOptions): BackupResult {
  const home = resolve(options.home);
  if (!existsSync(home) || !statSync(home).isDirectory()) {
    throw new BackupError(`OCX home not found: ${redactUserPath(home)}`);
  }
  const dest = resolve(options.dest ?? defaultBackupDest(home, options.now));
  if (existsSync(dest)) {
    throw new BackupError(`refusing to overwrite existing backup: ${redactUserPath(dest)}`);
  }

  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  mkdirSync(dest, { recursive: false, mode: 0o700 });

  const copied: BackupStateFile[] = [];
  const absent: BackupStateFile[] = [];
  const files = BACKUP_STATE_FILES.map((name) => {
    const source = join(home, name);
    const before = fingerprintBackupFile(home, name);
    if (!before.present) {
      absent.push(name);
      return before;
    }
    copyFileSync(source, join(dest, name));
    copied.push(name);
    return fingerprintBackupFile(dest, name);
  });

  const manifest: BackupManifest = {
    version: 1,
    createdAt: (options.now ?? new Date()).toISOString(),
    sourceDir: home,
    destDir: dest,
    files,
  };
  writeFileSync(join(dest, BACKUP_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { dest, manifest, copied, absent };
}

if (import.meta.main) {
  try {
    const result = backupState(parseBackupArgs(process.argv.slice(2)));
    process.stdout.write(String(redactSecrets(formatBackupReport(result))));
    process.exit(0);
  } catch (error) {
    const message = error instanceof BackupError
      ? error.message
      : error instanceof Error ? error.message : String(error);
    process.stderr.write(`${redactSecrets(message)}\n`);
    process.exit(error instanceof BackupError ? error.exitCode : 1);
  }
}
