import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClientArtifact } from "../scripts/build-client-artifact";

const scratch = mkdtempSync(join(tmpdir(), "ocx-client-artifact-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("remote client artifact", () => {
  test("CLI builds from an explicit clean source checkout", () => {
    const output = join(scratch, "explicit-source-candidate");
    const root = join(import.meta.dir, "..");
    const script = join(root, "scripts/build-client-artifact.ts");
    const result = Bun.spawnSync(
      [process.execPath, script, "--output", output, "--source-root", root],
      { cwd: scratch },
    );
    expect(result.exitCode).toBe(0);
    const sourceSha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root })
      .stdout.toString()
      .trim();
    expect(readFileSync(join(output, "source-sha"), "utf8")).toBe(
      sourceSha + "\n",
    );
  });

  test("builds a self-contained, SHA-bound candidate without activation", async () => {
    const output = join(scratch, "candidate");
    const manifest = await buildClientArtifact(output);
    const entry = join(output, "src/cli/index.js");
    const digest = createHash("sha256")
      .update(readFileSync(entry))
      .digest("hex");
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], {
        cwd: join(import.meta.dir, ".."),
      });
      expect(result.success).toBe(true);
      return result.stdout.toString().trim();
    };
    const sourceSha = git("rev-parse", "HEAD");
    const packageText = git("show", `${sourceSha}:package.json`) + "\n";
    const lock = readFileSync(join(import.meta.dir, "../bun.lock"));
    const builder = readFileSync(
      fileURLToPath(
        new URL("../scripts/build-client-artifact.ts", import.meta.url),
      ),
    );
    expect(manifest.sourceSha).toBe(sourceSha);
    expect(readFileSync(join(output, "source-sha"), "utf8")).toBe(
      manifest.sourceSha + "\n",
    );
    expect(readFileSync(join(output, "index.js.sha256"), "utf8")).toBe(
      `${digest}  src/cli/index.js\n`,
    );
    expect(manifest.files["src/cli/index.js"]).toBe(digest);
    expect(manifest.files["package.json"]).toBe(
      createHash("sha256").update(packageText).digest("hex"),
    );
    expect(manifest.lockSha256).toBe(
      createHash("sha256").update(lock).digest("hex"),
    );
    expect(manifest.builderSha256).toBe(
      createHash("sha256").update(builder).digest("hex"),
    );
    expect(readFileSync(join(output, "package.json"), "utf8")).toBe(
      packageText,
    );
    const metadata = JSON.parse(
      readFileSync(join(output, "package.json"), "utf8"),
    );
    expect(existsSync(join(output, "node_modules"))).toBe(false);
    expect(existsSync(join(scratch, "current"))).toBe(false);
    const env = {
      ...process.env,
      OPENCODEX_HOME: join(scratch, "ocx-home"),
      CODEX_HOME: join(scratch, "codex-home"),
    };
    mkdirSync(env.OPENCODEX_HOME);
    mkdirSync(env.CODEX_HOME);
    const version = Bun.spawnSync([process.execPath, entry, "--version"], {
      env,
      cwd: scratch,
    });
    expect(version.exitCode).toBe(0);
    expect(version.stdout.toString()).toContain(
      `opencodex ${metadata.version}`,
    );
    expect(readFileSync(entry, "utf8")).toContain("syncExternalOcxCatalog");
    for (const command of [
      "start",
      "ensure",
      "service",
      "init",
      "__startup-health",
    ]) {
      const denied = Bun.spawnSync([process.execPath, entry, command], {
        env,
        cwd: scratch,
      });
      expect(denied.exitCode).toBe(64);
      expect(denied.stderr.toString()).toContain(
        "local lifecycle commands are disabled",
      );
    }
    expect(existsSync(join(scratch, "ocx-home", "proxy.pid"))).toBe(false);
    await expect(buildClientArtifact(output)).rejects.toThrow(
      "Destination already exists",
    );
    expect(createHash("sha256").update(readFileSync(entry)).digest("hex")).toBe(
      digest,
    );

    const duplicate = join(scratch, "duplicate");
    await buildClientArtifact(duplicate);
    expect(readFileSync(join(duplicate, "src/cli/index.js"))).toEqual(
      readFileSync(entry),
    );
    expect(readFileSync(join(duplicate, "artifact-manifest.json"))).toEqual(
      readFileSync(join(output, "artifact-manifest.json")),
    );
  });

  test("ships a client shim that cannot select the native Codex home", async () => {
    const output = join(scratch, "shim-candidate");
    const manifest = await buildClientArtifact(output);
    const shim = join(output, "bin/codex.ocx-client");
    const home = join(scratch, "shim-home");
    const nativeHome = join(home, ".codex");
    const capture = join(scratch, "captured-home");
    const real = join(scratch, "codex-real");
    mkdirSync(nativeHome, { recursive: true });
    writeFileSync(
      join(nativeHome, "config.toml"),
      "direct Azure config stays untouched\n",
    );
    writeFileSync(
      real,
      '#!/usr/bin/env sh\nprintf \'%s\\n\' "$CODEX_HOME" > "$OCX_CAPTURE"\n',
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      HOME: home,
      CODEX_HOME: nativeHome,
      OCX_CAPTURE: capture,
      OCX_CLIENT_CODEX_BIN: real,
      OCX_CLIENT_OCX_BIN: "/bin/false",
    };

    expect(statSync(shim).mode & 0o777).toBe(0o755);
    expect(manifest.files["bin/codex.ocx-client"]).toBe(
      createHash("sha256").update(readFileSync(shim)).digest("hex"),
    );
    const defaultRun = Bun.spawnSync([shim, "--version"], { env });
    expect(defaultRun.exitCode).toBe(0);
    expect(readFileSync(capture, "utf8")).toBe(join(home, ".codex-ocx") + "\n");
    expect(readFileSync(join(nativeHome, "config.toml"), "utf8")).toBe(
      "direct Azure config stays untouched\n",
    );

    const selected = join(home, ".codex-client-test");
    const selectedRun = Bun.spawnSync([shim, "--version"], {
      env: { ...env, OCX_CLIENT_CODEX_HOME: selected },
    });
    expect(selectedRun.exitCode).toBe(0);
    expect(readFileSync(capture, "utf8")).toBe(selected + "\n");

    const nativeRun = Bun.spawnSync([shim, "--version"], {
      env: { ...env, OCX_CLIENT_CODEX_HOME: nativeHome },
    });
    expect(nativeRun.exitCode).toBe(78);
    expect(nativeRun.stderr.toString()).toContain("refusing native Codex home");
    expect(readFileSync(capture, "utf8")).toBe(selected + "\n");
    expect(readFileSync(join(nativeHome, "config.toml"), "utf8")).toBe(
      "direct Azure config stays untouched\n",
    );
  });

  test("does not replace an existing destination symlink", async () => {
    const existing = join(scratch, "existing");
    writeFileSync(existing, "preserve");
    const link = join(scratch, "alias");
    symlinkSync(existing, link);
    await expect(buildClientArtifact(link)).rejects.toThrow(
      "Destination already exists",
    );
    expect(readFileSync(existing, "utf8")).toBe("preserve");
  });

  test("rejects untracked runtime inputs before creating an artifact", async () => {
    const fixture = mkdtempSync(join(scratch, "dirty-"));
    expect(Bun.spawnSync(["git", "init", fixture]).success).toBe(true);
    writeFileSync(join(fixture, "bun.lock"), "untracked input");
    const destination = join(scratch, "dirty-output");
    await expect(buildClientArtifact(destination, fixture)).rejects.toThrow(
      "Runtime inputs are dirty",
    );
    expect(existsSync(destination)).toBe(false);
  });
});
