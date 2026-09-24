import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHA = "a".repeat(40);
const DIGEST = "sha256:" + "d".repeat(64);
const ROOT = new URL("..", import.meta.url).pathname;
const BINDING = {
  tenantId: "test-tenant",
  projectId: "test-project",
  repositoryId: "test-repo",
  connectorId: "test-github",
  providerRepositoryId: "test-provider",
  configurationRevision: 1,
  environmentId: "test-environment",
};

async function run(overrides: {
  now?: string;
  fresh?: string;
  displayDigest?: string;
}) {
  const dir = await mkdtemp(join(tmpdir(), "ocx-receipt-validation-"));
  const binding = join(dir, "binding.json");
  const html = join(dir, "gui.html");
  const out = join(dir, "receipt.json");
  try {
    await writeFile(binding, JSON.stringify(BINDING));
    await writeFile(
      html,
      '<meta name="ocx-build-version" content="1.5.0"><meta name="ocx-build-sha" content="' +
        SHA +
        '">',
    );
    const cmd = [
      "python3",
      "scripts/status-version-receipt.py",
      "assemble",
      "--binding",
      binding,
      "--now",
      overrides.now ?? "2026-09-24T01:00:00Z",
      "--fresh-until",
      overrides.fresh ?? "2026-09-24T01:05:00Z",
      "--artifact-version",
      "1.5.0",
      "--artifact-source-sha",
      SHA,
      "--artifact-digest",
      DIGEST,
      "--runtime-version",
      "1.5.0",
      "--runtime-source-sha",
      SHA,
      "--runtime-digest",
      DIGEST,
      "--display-html",
      html,
      "--display-digest",
      overrides.displayDigest ?? DIGEST,
      "--verification-ref",
      "https://ocx.example.test/",
      "--operation-id",
      "test-run",
      "--operation-owner",
      "test-deployer",
      "--operation-status",
      "succeeded",
      "--desired-sha",
      SHA,
      "--authority",
      "test-authority",
      "--evidence-ref",
      "test-evidence",
      "--out",
      out,
    ];
    const result = Bun.spawnSync({
      cmd,
      cwd: ROOT,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    return {
      code: result.exitCode,
      stderr: result.stderr.toString(),
      stdout: result.stdout.toString(),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("producer receipt refuses a malformed displayed artifact digest", async () => {
  const result = await run({ displayDigest: "garbage" });
  expect(result.code).not.toBe(0);
  expect(result.stderr + result.stdout).toContain("--display-digest");
});

test("producer receipt refuses reversed or invalid evidence freshness", async () => {
  for (const args of [
    { now: "2026-09-24T01:05:00Z", fresh: "2026-09-24T01:00:00Z" },
    { now: "2026-09-24T01:00:00Z", fresh: "2026-09-24T01:00:00Z" },
    { now: "2026-13-24T01:00:00Z", fresh: "2026-13-24T01:05:00Z" },
  ]) {
    const result = await run(args);
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("fresh");
  }
});

test("producer receipt accepts valid independent metadata with bounded freshness", async () => {
  const result = await run({});
  expect(result.code).toBe(0);
});
