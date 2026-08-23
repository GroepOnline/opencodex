import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUP_MANIFEST_NAME,
  ReconcileError,
  createBackup,
  diffDomains,
  formatReport,
  inventoryStore,
  normalizeAuthStore,
  normalizeConfig,
  parseReconcileArgs,
  redactForLog,
  runReconcile,
  secretShape,
  verifyBackup,
} from "../scripts/state-reconcile";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
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

function provider(name: string, extra: Record<string, unknown> = {}) {
  return {
    [name]: {
      adapter: "openai-chat",
      baseUrl: `https://${name}.example.test/v1`,
      authMode: "key",
      apiKey: `\${${name.toUpperCase()}_API_KEY}`,
      ...extra,
    },
  };
}

function currentConfig(overrides: Record<string, unknown> = {}) {
  return {
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "deepseek",
    openaiProviderTierVersion: 2,
    providers: {
      ...provider("deepseek", { apiKey: "sk-test-11111111111111111111", apiKeyPool: [{ id: "aaaa1111", key: "sk-test-11111111111111111111" }] }),
      ...provider("google-antigravity", { adapter: "google", authMode: "oauth", baseUrl: "https://daily-cloudcode-pa.googleapis.com" }),
    },
    apiKeys: [{ id: "e224fe64-19e2-4cce-a9c3-3d32dbae2904", name: "default", key: "ocx_test_admission_key_value_xxxx", createdAt: "2026-07-31T12:45:45.608Z" }],
    combos: { "google-combo": { targets: [{ provider: "deepseek", model: "deepseek-v4-flash" }], strategy: "failover" } },
    disabledModels: ["hidden/one"],
    subagentModels: ["deepseek/deepseek-v4-flash"],
    ...overrides,
  };
}

function seedCurrent(dir: string, overrides: Record<string, unknown> = {}): void {
  writeJson(dir, "config.json", currentConfig(overrides));
  writeFileSync(join(dir, "usage.jsonl"), `${JSON.stringify({ requestId: "live-1", timestamp: 1_700_000_000_000, provider: "deepseek", status: 200 })}\n`);
}

describe("state reconcile inventory", () => {
  test("records names and shapes, never secret values", () => {
    const dir = scratch("ocx-reconcile-inv-");
    seedCurrent(dir);
    writeJson(dir, "auth.json", {
      "google-antigravity": {
        activeAccountId: "acct-1",
        accounts: [{
          id: "acct-1",
          credential: { access: "aaaa".repeat(20), refresh: "bbbb".repeat(20), expires: 1 },
        }],
      },
    });
    const inventory = inventoryStore(dir, "current");
    expect(inventory.providers.map((row) => row.name).sort()).toEqual(["deepseek", "google-antigravity"]);
    expect(inventory.apiKeys[0]?.id).toBe("e224fe64-19e2-4cce-a9c3-3d32dbae2904");
    expect(inventory.apiKeys[0]?.key).toEqual({ present: true, length: 33, envRef: false });
    expect(inventory.oauthAccounts).toEqual([expect.objectContaining({
      provider: "google-antigravity",
      id: "acct-1",
      hasRefresh: true,
      refreshLen: 80,
    })]);
    const dumped = JSON.stringify(inventory);
    expect(dumped).not.toContain("sk-test-11111111111111111111");
    expect(dumped).not.toContain("aaaa".repeat(20));
    expect(dumped).not.toContain("ocx_test_admission_key_value_xxxx");
  });

  test("diff reports legacy records missing from current", () => {
    const currentDir = scratch("ocx-reconcile-cur-");
    const legacyDir = scratch("ocx-reconcile-leg-");
    seedCurrent(currentDir);
    writeJson(legacyDir, "config.json", currentConfig({
      providers: {
        ...currentConfig().providers,
        ...provider("kilo"),
      },
      apiKeys: [
        { id: "e224fe64-19e2-4cce-a9c3-3d32dbae2904", name: "default", key: "ocx_test_admission_key_value_xxxx", createdAt: "2026-07-31T12:45:45.608Z" },
        { id: "legacy-only-key", name: "old", key: "ocx_test_old_key_value_yyyy", createdAt: "2026-07-01T00:00:00.000Z" },
      ],
    }));
    writeJson(legacyDir, "auth.json", {
      cursor: { activeAccountId: "cur-1", accounts: [{ id: "cur-1", credential: { access: "x".repeat(20), refresh: "y".repeat(20), expires: 1 } }] },
    });
    writeFileSync(join(legacyDir, "usage.jsonl"), `${JSON.stringify({ requestId: "old-9", timestamp: 1, provider: "kilo", status: 200 })}\n`);
    const domains = diffDomains(inventoryStore(currentDir, "current"), [inventoryStore(legacyDir, "legacy-0")]);
    expect(domains.find((row) => row.domain === "providers")?.missingFromCurrent).toEqual(["kilo"]);
    expect(domains.find((row) => row.domain === "apiKeys")?.missingFromCurrent).toEqual(["legacy-only-key"]);
    expect(domains.find((row) => row.domain === "oauthAccounts")?.missingFromCurrent).toEqual(["cursor:cur-1"]);
    expect(domains.find((row) => row.domain === "usage")?.missingFromCurrent).toEqual(["old-9"]);
  });
});

describe("state reconcile pipeline", () => {
  test("dry-run does not write current, staging, or backup", () => {
    const currentDir = scratch("ocx-reconcile-dry-c-");
    const legacyDir = scratch("ocx-reconcile-dry-l-");
    const backupDir = scratch("ocx-reconcile-dry-b-");
    const stagingDir = join(scratch("ocx-reconcile-dry-s-"), "staging");
    seedCurrent(currentDir);
    writeJson(legacyDir, "config.json", currentConfig({ providers: { ...currentConfig().providers, ...provider("kilo") } }));
    const before = readdirSync(currentDir).sort();
    const report = runReconcile({
      currentDir,
      legacyDirs: [legacyDir],
      backupDir,
      stagingDir,
      mode: "dry-run",
      prefer: "current",
    });
    expect(report.mode).toBe("dry-run");
    expect(report.wrote).toEqual([]);
    expect(report.domains.find((row) => row.domain === "providers")?.missingFromCurrent).toEqual(["kilo"]);
    expect(readdirSync(currentDir).sort()).toEqual(before);
    expect(existsSync(join(backupDir, BACKUP_MANIFEST_NAME))).toBe(false);
    expect(existsSync(join(stagingDir, "config.json"))).toBe(false);
  });

  test("apply refuses without a backup directory", () => {
    const currentDir = scratch("ocx-reconcile-nobak-c-");
    const legacyDir = scratch("ocx-reconcile-nobak-l-");
    seedCurrent(currentDir);
    writeJson(legacyDir, "config.json", currentConfig());
    expect(() => runReconcile({
      currentDir,
      legacyDirs: [legacyDir],
      stagingDir: scratch("ocx-reconcile-nobak-s-"),
      mode: "apply",
      prefer: "current",
    })).toThrow(ReconcileError);
  });

  test("apply writes staging only and is idempotent", () => {
    const currentDir = scratch("ocx-reconcile-app-c-");
    const legacyDir = scratch("ocx-reconcile-app-l-");
    const backupDir = scratch("ocx-reconcile-app-b-");
    const stagingDir = scratch("ocx-reconcile-app-s-");
    seedCurrent(currentDir);
    writeJson(legacyDir, "config.json", currentConfig({
      providers: { ...currentConfig().providers, ...provider("kilo") },
    }));
    writeJson(legacyDir, "auth.json", {
      cursor: { access: "x".repeat(24), refresh: "y".repeat(24), expires: 9, accountId: "legacy-cursor" },
    });
    const first = runReconcile({
      currentDir,
      legacyDirs: [legacyDir],
      backupDir,
      stagingDir,
      mode: "apply",
      prefer: "current",
    });
    expect(first.backup.verified).toBe(true);
    expect(first.wrote.some((path) => path.startsWith("live:"))).toBe(false);
    expect(existsSync(join(stagingDir, "config.json"))).toBe(true);
    const staged = JSON.parse(readFileSync(join(stagingDir, "config.json"), "utf8")) as {
      schemaVersion?: number;
      providers?: Record<string, { apiKey?: string }>;
    };
    expect(staged.schemaVersion).toBe(1);
    expect(staged.providers?.kilo).toBeDefined();
    expect(verifyBackup(currentDir, backupDir).ok).toBe(true);
    const liveBefore = readFileSync(join(currentDir, "config.json"), "utf8");
    const second = runReconcile({
      currentDir,
      legacyDirs: [legacyDir],
      backupDir,
      stagingDir,
      mode: "apply",
      prefer: "current",
    });
    expect(second.stagingDigest).toBe(first.stagingDigest);
    expect(readFileSync(join(currentDir, "config.json"), "utf8")).toBe(liveBefore);
    const auth = JSON.parse(readFileSync(join(stagingDir, "auth.json"), "utf8")) as {
      cursor?: { accounts?: Array<{ id?: string }> };
    };
    expect(auth.cursor?.accounts?.[0]?.id).toBe("legacy-cursor");
  });

  test("promote updates live and rollback restores it", () => {
    const currentDir = scratch("ocx-reconcile-pro-c-");
    const legacyDir = scratch("ocx-reconcile-pro-l-");
    const backupDir = scratch("ocx-reconcile-pro-b-");
    const stagingDir = scratch("ocx-reconcile-pro-s-");
    seedCurrent(currentDir);
    const original = readFileSync(join(currentDir, "config.json"), "utf8");
    writeJson(legacyDir, "config.json", currentConfig({
      providers: { ...currentConfig().providers, ...provider("kilo") },
    }));
    runReconcile({
      currentDir,
      legacyDirs: [legacyDir],
      backupDir,
      stagingDir,
      mode: "promote",
      prefer: "current",
    });
    const promoted = JSON.parse(readFileSync(join(currentDir, "config.json"), "utf8")) as {
      providers?: Record<string, unknown>;
      schemaVersion?: number;
    };
    expect(promoted.providers?.kilo).toBeDefined();
    expect(promoted.schemaVersion).toBe(1);
    const rolled = runReconcile({
      currentDir,
      legacyDirs: [],
      backupDir,
      mode: "rollback",
      prefer: "current",
    });
    expect(rolled.wrote.length).toBeGreaterThan(0);
    expect(readFileSync(join(currentDir, "config.json"), "utf8")).toBe(original);
  });

  test("report and redaction never echo secret values", () => {
    expect(secretShape("${NVIDIA_API_KEY}")).toEqual({ present: true, length: 17, envRef: true });
    expect(redactForLog({ apiKey: "sk-test-11111111111111111111", name: "deepseek" })).toEqual({
      apiKey: "<redacted len=28 envRef=false>",
      name: "deepseek",
    });
    const currentDir = scratch("ocx-reconcile-red-c-");
    const legacyDir = scratch("ocx-reconcile-red-l-");
    seedCurrent(currentDir);
    writeJson(legacyDir, "config.json", currentConfig());
    const text = formatReport(runReconcile({
      currentDir,
      legacyDirs: [legacyDir],
      mode: "dry-run",
      prefer: "current",
    }));
    expect(text).toContain("providers: current=2");
    expect(text).not.toContain("sk-test-11111111111111111111");
    expect(text).not.toContain("ocx_test_admission_key_value_xxxx");
  });
});

describe("state reconcile helpers", () => {
  test("parse args default to dry-run and require legacy", () => {
    expect(parseReconcileArgs(["--current", "/tmp/a", "--legacy", "/tmp/b"]).mode).toBe("dry-run");
    expect(() => parseReconcileArgs(["--current", "/tmp/a"])).toThrow(ReconcileError);
    expect(parseReconcileArgs(["--current", "/tmp/a", "--legacy", "/tmp/b", "--apply", "--promote"]).mode).toBe("promote");
  });

  test("normalize seeds schemaVersion and multiauth shape", () => {
    const config = normalizeConfig({ providers: { x: { adapter: "openai-chat", baseUrl: "https://x.test", apiKey: "sk-test-22222222222222222222" } } });
    expect(config.schemaVersion).toBe(1);
    const pool = (config.providers as Record<string, { apiKeyPool?: Array<{ id: string }> }>).x.apiKeyPool;
    expect(pool?.[0]?.id).toHaveLength(8);
    const auth = normalizeAuthStore({
      cursor: { access: "a".repeat(20), refresh: "b".repeat(20), expires: 1, accountId: "c1" },
    });
    expect(auth).toEqual({
      cursor: { activeAccountId: "c1", accounts: [{ id: "c1", credential: expect.objectContaining({ accountId: "c1" }) }] },
    });
  });

  test("createBackup is verifiable and detects drift", () => {
    const currentDir = scratch("ocx-reconcile-bak-c-");
    const backupDir = scratch("ocx-reconcile-bak-b-");
    seedCurrent(currentDir);
    createBackup(currentDir, backupDir);
    expect(verifyBackup(currentDir, backupDir).ok).toBe(true);
    writeFileSync(join(backupDir, "config.json"), "{\"tampered\":true}\n");
    expect(verifyBackup(currentDir, backupDir).ok).toBe(false);
  });
});
