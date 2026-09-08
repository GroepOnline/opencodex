import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUP_MANIFEST_NAME,
  BACKUP_STATE_FILES,
  BackupError,
  backupState,
  formatBackupReport,
  parseBackupArgs,
} from "../scripts/backup-state";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.OPENCODEX_HOME;
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeJson(dir: string, name: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function seedHome(dir: string, opts: { auth?: boolean } = {}): void {
  writeJson(dir, "config.json", {
    port: 10100,
    defaultProvider: "deepseek",
    providers: {
      deepseek: {
        adapter: "openai-chat",
        baseUrl: "https://deepseek.example.test/v1",
        authMode: "key",
        apiKey: "tokenless-fixture-value",
      },
    },
  });
  writeFileSync(
    join(dir, "usage.jsonl"),
    `${JSON.stringify({ requestId: "live-1", timestamp: 1_700_000_000_000, provider: "deepseek", status: 200 })}\n`,
  );
  if (opts.auth) {
    writeJson(dir, "auth.json", {
      "google-antigravity": {
        activeAccountId: "acct-1",
        accounts: [
          {
            id: "acct-1",
            credential: {
              access: "aaaa".repeat(20),
              refresh: "bbbb".repeat(20),
            },
          },
        ],
      },
    });
  }
}

describe("backup-state", () => {
  test("creates a sha256 manifest and copies present files including inline keys", () => {
    const home = scratch("ocx-backup-home-");
    const dest = join(scratch("ocx-backup-dest-"), "2026-08-23T00-00-00-000Z");
    seedHome(home, { auth: true });
    writeJson(home, "codex-accounts.json", { accounts: [] });
    writeJson(home, "account-runtime.json", { needsReauth: [] });

    const result = backupState({ home, dest });
    expect(result.copied).toEqual([...BACKUP_STATE_FILES]);
    expect(result.absent).toEqual([]);
    expect(existsSync(join(dest, BACKUP_MANIFEST_NAME))).toBe(true);

    const manifest = JSON.parse(
      readFileSync(join(dest, BACKUP_MANIFEST_NAME), "utf8"),
    ) as {
      version: number;
      files: Array<{ name: string; present: boolean; sha256: string | null }>;
    };
    expect(manifest.version).toBe(1);
    expect(manifest.files).toHaveLength(BACKUP_STATE_FILES.length);
    for (const file of BACKUP_STATE_FILES) {
      const row = manifest.files.find((entry) => entry.name === file);
      expect(row?.present).toBe(true);
      expect(row?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(readFileSync(join(dest, file), "utf8")).toBe(
        readFileSync(join(home, file), "utf8"),
      );
    }
    expect(readFileSync(join(dest, "config.json"), "utf8")).toContain(
      "tokenless-fixture-value",
    );

    const report = formatBackupReport(result);
    expect(report).toContain("backed up 5 file(s)");
    expect(report).not.toContain("tokenless-fixture-value");
    expect(report).not.toContain("aaaa".repeat(20));
  });

  test("refuses to overwrite an existing destination", () => {
    const home = scratch("ocx-backup-ow-home-");
    const dest = join(scratch("ocx-backup-ow-dest-"), "already");
    seedHome(home);
    backupState({ home, dest });
    expect(() => backupState({ home, dest })).toThrow(BackupError);
    expect(() => backupState({ home, dest })).toThrow(/refusing to overwrite/);
  });

  test("does not fail when auth.json is missing (the live case)", () => {
    const home = scratch("ocx-backup-live-");
    const dest = join(
      scratch("ocx-backup-live-dest-"),
      "2026-08-23T01-00-00-000Z",
    );
    seedHome(home);
    expect(existsSync(join(home, "auth.json"))).toBe(false);

    const result = backupState({ home, dest });
    expect(result.copied).toEqual(["config.json", "usage.jsonl"]);
    expect(result.absent).toEqual([
      "auth.json",
      "codex-accounts.json",
      "account-runtime.json",
    ]);
    expect(existsSync(join(dest, "config.json"))).toBe(true);
    expect(existsSync(join(dest, "usage.jsonl"))).toBe(true);
    expect(existsSync(join(dest, "auth.json"))).toBe(false);

    const manifest = JSON.parse(
      readFileSync(join(dest, BACKUP_MANIFEST_NAME), "utf8"),
    ) as {
      files: Array<{ name: string; present: boolean; sha256: string | null }>;
    };
    expect(manifest.files.find((file) => file.name === "auth.json")).toEqual({
      name: "auth.json",
      present: false,
      size: null,
      sha256: null,
    });
  });

  test("defaults dest to $OPENCODEX_HOME/backups/<iso> and parses --home/--dest", () => {
    const home = scratch("ocx-backup-cli-");
    const dest = join(home, "explicit-dest");
    expect(parseBackupArgs(["--home", home, "--dest", dest])).toEqual({
      home,
      dest,
    });
    process.env.OPENCODEX_HOME = home;
    const parsed = parseBackupArgs([]);
    expect(parsed.home).toBe(home);
    expect(parsed.dest).toBeUndefined();
  });
});
