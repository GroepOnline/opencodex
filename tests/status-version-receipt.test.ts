import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const DIGEST = `sha256:${"d".repeat(64)}`;
const NOW = "2026-09-15T02:00:00Z";
const FRESH = "2026-09-15T02:05:00Z";
const TRACE = "c".repeat(32);
const root = new URL("..", import.meta.url).pathname;

const binding = {
  tenantId: "tenant",
  projectId: "project",
  repositoryId: "opencodex",
  connectorId: "github",
  providerRepositoryId: "123",
  configurationRevision: 7,
  environmentId: "production",
};

function runPython(code: string): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const result = Bun.spawnSync({
    cmd: ["python3", "-c", code],
    cwd: root,
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("status-version-receipt", () => {
  test("reads compiled GUI identity from HTML meta, not from /healthz JSON", () => {
    const result = runPython(
      "from importlib.machinery import SourceFileLoader; " +
        "m=SourceFileLoader('r','scripts/status-version-receipt.py').load_module(); " +
        'print(m.parse_build_version_meta(\'<meta name="ocx-build-version" content="1.5.0">\') or ""); ' +
        'print(m.parse_build_sha_meta(\'<meta name="ocx-build-version" content="1.5.0">\') or "none"); ' +
        `print(m.parse_build_version_meta('{"status":"ok","version":"1.5.0","gitSha":"${SHA}"}') or "none")`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["1.5.0", "none", "none"]);
  });

  test("CLI assemble keeps runtime unknown when the GUI does not stamp a SHA", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocx-receipt-"));
    const bindingPath = join(dir, "binding.json");
    const htmlPath = join(dir, "dashboard.html");
    const outPath = join(dir, "receipt.json");
    await writeFile(bindingPath, `${JSON.stringify(binding)}\n`);
    await writeFile(
      htmlPath,
      `<meta name="ocx-build-version" content="1.5.0">\n`,
    );
    const result = Bun.spawnSync({
      cmd: [
        "python3",
        "scripts/status-version-receipt.py",
        "assemble",
        "--binding",
        bindingPath,
        "--now",
        NOW,
        "--fresh-until",
        FRESH,
        "--trace-id",
        TRACE,
        "--artifact-version",
        "1.5.0",
        "--artifact-source-sha",
        SHA,
        "--artifact-digest",
        `ghcr.io/groeponline/opencodex@${DIGEST}`,
        "--runtime-version",
        "1.5.0",
        "--runtime-source-sha",
        SHA,
        "--runtime-digest",
        DIGEST,
        "--display-html",
        htmlPath,
        "--verification-ref",
        "http://127.0.0.1:10100/",
        "--operation-id",
        "run-1",
        "--operation-owner",
        "fable-opencodex-deploy",
        "--operation-status",
        "succeeded",
        "--desired-sha",
        SHA,
        "--authority",
        "deploy.yml",
        "--evidence-ref",
        "https://github.com/GroepOnline/opencodex/actions/runs/1",
        "--out",
        outPath,
      ],
      cwd: root,
    });
    expect(result.exitCode).toBe(0);
    const written = JSON.parse(await Bun.file(outPath).text()) as {
      schemaVersion: string;
      runtime: { kind: string; reason?: string };
      artifact: { value: { artifactDigest: string } };
      operation: { value: { status: string } };
    };
    expect(written.schemaVersion).toBe("1");
    expect(written.artifact.value.artifactDigest).toBe(DIGEST);
    expect(written.runtime).toEqual({
      kind: "unknown",
      reason: "display_source_sha_unobservable",
    });
    expect(written.operation.value.status).toBe("succeeded");
  });

  test("refuses display flags that copy /healthz instead of reading HTML", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocx-receipt-"));
    const bindingPath = join(dir, "binding.json");
    const outPath = join(dir, "receipt.json");
    await writeFile(bindingPath, `${JSON.stringify(binding)}\n`);
    const result = Bun.spawnSync({
      cmd: [
        "python3",
        "scripts/status-version-receipt.py",
        "assemble",
        "--binding",
        bindingPath,
        "--now",
        NOW,
        "--fresh-until",
        FRESH,
        "--trace-id",
        TRACE,
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
        "--display-version",
        "1.5.0",
        "--display-source-sha",
        OTHER,
        "--display-digest",
        `sha256:${"e".repeat(64)}`,
        "--verification-ref",
        "http://127.0.0.1:10100/healthz",
        "--operation-id",
        "run-1",
        "--operation-owner",
        "fable-opencodex-deploy",
        "--operation-status",
        "succeeded",
        "--desired-sha",
        SHA,
        "--authority",
        "deploy.yml",
        "--evidence-ref",
        "https://github.com/GroepOnline/opencodex/actions/runs/1",
        "--out",
        outPath,
      ],
      cwd: root,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString() + result.stdout.toString()).toContain(
      "independent HTML/browser read",
    );
  });
});
