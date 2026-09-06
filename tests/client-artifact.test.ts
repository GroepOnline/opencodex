import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
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
const powershell = Bun.which("pwsh");
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
  }, 15_000);

  test("refuses an uncommitted artifact builder", () => {
    const root = join(import.meta.dir, "..");
    const dirtyRoot = join(scratch, "dirty-builder-checkout");
    const clone = Bun.spawnSync(["git", "clone", "--shared", root, dirtyRoot]);
    expect(clone.success).toBe(true);
    const builder = join(dirtyRoot, "scripts/build-client-artifact.ts");
    writeFileSync(
      builder,
      readFileSync(builder, "utf8") + "\n// dirty builder probe\n",
    );
    const output = join(scratch, "dirty-builder-candidate");
    const result = Bun.spawnSync(
      [
        process.execPath,
        builder,
        "--output",
        output,
        "--source-root",
        dirtyRoot,
      ],
      { cwd: dirtyRoot },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "Artifact builder is dirty; commit the reviewed builder before building",
    );
    expect(existsSync(output)).toBe(false);
  });

  test("reinstalls frozen dependencies before bundling", async () => {
    const root = join(import.meta.dir, "..");
    const sourceRoot = join(scratch, "dependency-drift-checkout");
    const clone = Bun.spawnSync(["git", "clone", "--shared", root, sourceRoot]);
    expect(clone.success).toBe(true);
    const install = Bun.spawnSync(
      [process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"],
      { cwd: sourceRoot },
    );
    expect(install.success).toBe(true);
    const zodEntry = join(sourceRoot, "node_modules/zod/v4/index.js");
    writeFileSync(
      zodEntry,
      readFileSync(zodEntry, "utf8") +
        '\nconsole.error("DEPENDENCY_DRIFT_SENTINEL");\n',
    );

    const output = join(scratch, "dependency-drift-candidate");
    const manifest = await buildClientArtifact(output, sourceRoot);
    expect(
      readFileSync(join(output, "src/cli/index.js"), "utf8"),
    ).not.toContain("DEPENDENCY_DRIFT_SENTINEL");
    expect(readFileSync(zodEntry, "utf8")).toContain(
      "DEPENDENCY_DRIFT_SENTINEL",
    );
    const locked = readFileSync(join(sourceRoot, "bun.lock"));
    expect(manifest.lockSha256).toBe(
      createHash("sha256").update(locked).digest("hex"),
    );
  }, 15_000);

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
    expect(readFileSync(entry, "utf8")).not.toMatch(
      /ocx-client-source-[A-Za-z0-9_-]+/,
    );
    expect(manifest.files["package.json"]).toBe(
      createHash("sha256").update(packageText).digest("hex"),
    );
    expect(manifest.lockSha256).toBe(
      createHash("sha256").update(lock).digest("hex"),
    );
    expect(manifest.builderSourceSha).toBe(sourceSha);
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
      ["start"],
      ["ensure"],
      ["service"],
      ["init"],
      ["__startup-health"],
      ["sync"],
      ["sync", "--restart-codex"],
      ["sync-cache", "--restart-codex"],
      ["v2", "mode", "v2"],
      ["recover-history", "--legacy-openai"],
      ["codex-shim", "install"],
      ["status"],
      ["health"],
    ]) {
      const denied = Bun.spawnSync([process.execPath, entry, ...command], {
        env,
        cwd: scratch,
      });
      expect(denied.exitCode).toBe(64);
      expect(denied.stderr.toString()).toContain(
        "local lifecycle commands are disabled",
      );
    }
    const staleShimHome = join(scratch, "stale-shim-home");
    const staleShimBin = join(scratch, "stale-shim-bin");
    const staleWrapper = join(staleShimBin, "codex");
    const staleBackup = join(staleShimBin, "codex.opencodex-real");
    const staleReplacement =
      "replacement that direct artifact status must not promote\n";
    mkdirSync(staleShimHome);
    mkdirSync(staleShimBin);
    writeFileSync(staleWrapper, staleReplacement);
    writeFileSync(staleBackup, "known-good prior launcher\n");
    writeFileSync(
      join(staleShimHome, "codex-shim.json"),
      `${JSON.stringify({
        platform: process.platform,
        wrapperPath: staleWrapper,
        originalPath: staleWrapper,
        backupPath: staleBackup,
      })}\n`,
    );
    const staleState = readFileSync(join(staleShimHome, "codex-shim.json"));
    const staleRun = Bun.spawnSync([process.execPath, entry, "status"], {
      env: { ...env, OPENCODEX_HOME: staleShimHome, PATH: staleShimBin },
      cwd: scratch,
    });
    expect(staleRun.exitCode).toBe(64);
    expect(readFileSync(staleWrapper, "utf8")).toBe(staleReplacement);
    expect(readFileSync(staleBackup, "utf8")).toBe(
      "known-good prior launcher\n",
    );
    expect(readFileSync(join(staleShimHome, "codex-shim.json"))).toEqual(
      staleState,
    );
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
  }, 30_000);

  test("ships a client shim that cannot select the native Codex home", async () => {
    const output = join(scratch, "shim-candidate");
    const manifest = await buildClientArtifact(output);
    const shim = join(output, "bin/codex.ocx-client");
    const powershellShim = join(output, "bin/codex.ocx-client.ps1");
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
    expect(manifest.files["bin/codex.ocx-client.ps1"]).toBe(
      createHash("sha256").update(readFileSync(powershellShim)).digest("hex"),
    );
    expect(readFileSync(powershellShim, "utf8")).toContain(
      "Test-ReparsePointPath",
    );
    expect(readFileSync(powershellShim, "utf8")).toContain(
      "Resolve-PhysicalPath",
    );
    expect(readFileSync(powershellShim, "utf8")).toContain(
      "$item.ResolveLinkTarget($true)",
    );
    expect(readFileSync(powershellShim, "utf8")).toContain(
      "$targets = @($item.Target)",
    );
    expect(readFileSync(powershellShim, "utf8")).toContain(
      "$nativeHome = Resolve-PhysicalPath",
    );
    expect(readFileSync(powershellShim, "utf8")).toContain(
      "$clientHome = Resolve-PhysicalPath",
    );
    expect(readFileSync(powershellShim, "utf8")).toContain("$env:USERPROFILE");
    const defaultRun = Bun.spawnSync([shim, "--version"], { env });
    expect(defaultRun.exitCode).toBe(0);
    expect(readFileSync(capture, "utf8")).toBe(join(home, ".codex-ocx") + "\n");
    expect(readFileSync(join(nativeHome, "config.toml"), "utf8")).toBe(
      "direct Azure config stays untouched\n",
    );

    const normalizedNativeRun = Bun.spawnSync([shim, "--version"], {
      env: { ...env, OCX_CLIENT_CODEX_HOME: join(nativeHome, "..", ".codex") },
    });
    expect(normalizedNativeRun.exitCode).toBe(78);
    expect(normalizedNativeRun.stderr.toString()).toContain(
      "refusing native Codex home",
    );

    const nativeAlias = join(home, "native-codex-alias");
    symlinkSync(nativeHome, nativeAlias);
    const symlinkedNativeRun = Bun.spawnSync([shim, "--version"], {
      env: { ...env, OCX_CLIENT_CODEX_HOME: nativeAlias },
    });
    expect(symlinkedNativeRun.exitCode).toBe(78);
    expect(symlinkedNativeRun.stderr.toString()).toContain(
      "refusing symlinked Codex home path",
    );
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
  }, 15_000);

  test("refuses the physical target of a symlinked native Codex home", async () => {
    const output = join(scratch, "symlinked-native-candidate");
    await buildClientArtifact(output);
    const shim = join(output, "bin/codex.ocx-client");
    const home = join(scratch, "symlinked-native-home");
    const nativeHome = join(home, ".codex");
    const nativeTarget = join(scratch, "native-codex-target");
    const real = join(scratch, "symlinked-native-real");
    mkdirSync(home);
    mkdirSync(nativeTarget);
    symlinkSync(nativeTarget, nativeHome, "dir");
    writeFileSync(join(nativeTarget, "config.toml"), "native config\n");
    writeFileSync(real, "#!/usr/bin/env sh\nexit 0\n", { mode: 0o755 });
    const result = Bun.spawnSync([shim, "--version"], {
      env: {
        ...process.env,
        HOME: home,
        OCX_CLIENT_CODEX_HOME: nativeTarget,
        OCX_CLIENT_CODEX_BIN: real,
        OCX_CLIENT_OCX_BIN: "/bin/false",
      },
    });
    expect(result.exitCode).toBe(78);
    expect(result.stderr.toString()).toContain("refusing native Codex home");
    expect(readFileSync(join(nativeTarget, "config.toml"), "utf8")).toBe(
      "native config\n",
    );
  }, 15_000);

  test.skipIf(!powershell)(
    "PowerShell preserves the governed proxy failure exit code",
    async () => {
      const output = join(scratch, "powershell-proxy-failure-candidate");
      await buildClientArtifact(output);
      const shim = join(output, "bin/codex.ocx-client.ps1");
      const home = join(scratch, "powershell-proxy-failure-home");
      const failingOcx = join(scratch, "failing-ocx.ps1");
      mkdirSync(home);
      writeFileSync(failingOcx, "exit 7\n");
      const result = Bun.spawnSync([powershell!, "-NoProfile", "-File", shim], {
        env: {
          ...process.env,
          HOME: home,
          OCX_CLIENT_CODEX_HOME: join(home, ".codex-ocx"),
          OCX_CLIENT_OCX_BIN: failingOcx,
        },
      });
      expect(result.exitCode).toBe(69);
      expect(result.stderr.toString()).toContain(
        "central OCX proxy unavailable through the governed remote launcher",
      );
    },
  );

  test.skipIf(!powershell)(
    "PowerShell refuses the physical target of a symlinked native Codex home",
    async () => {
      const output = join(scratch, "powershell-symlinked-native-candidate");
      await buildClientArtifact(output);
      const shim = join(output, "bin/codex.ocx-client.ps1");
      const home = join(scratch, "powershell-symlinked-native-home");
      const nativeHome = join(home, ".codex");
      const nativeTarget = join(scratch, "powershell-native-codex-target");
      mkdirSync(home);
      mkdirSync(nativeTarget);
      symlinkSync(nativeTarget, nativeHome, "dir");
      writeFileSync(join(nativeTarget, "config.toml"), "native config\n");
      const result = Bun.spawnSync(
        [powershell!, "-NoProfile", "-File", shim, "--version"],
        {
          env: {
            ...process.env,
            HOME: home,
            OCX_CLIENT_CODEX_HOME: nativeTarget,
          },
        },
      );
      expect(result.exitCode).toBe(78);
      expect(result.stderr.toString()).toContain(
        "refusing native or symlinked Codex home",
      );
      expect(readFileSync(join(nativeTarget, "config.toml"), "utf8")).toBe(
        "native config\n",
      );
    },
  );

  test("refuses publication through a symlinked destination parent", async () => {
    const realParent = join(scratch, "real-publication-parent");
    const aliasParent = join(scratch, "aliased-publication-parent");
    mkdirSync(realParent);
    symlinkSync(realParent, aliasParent, "dir");
    const destination = join(aliasParent, "candidate");

    await expect(buildClientArtifact(destination)).rejects.toThrow(
      "Destination path traverses a symlink",
    );
    expect(existsSync(join(realParent, "candidate"))).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "refuses publication into a group- or world-writable parent",
    async () => {
      const unsafeParent = join(scratch, "unsafe-publication-parent");
      mkdirSync(unsafeParent);
      chmodSync(unsafeParent, 0o777);
      const destination = join(unsafeParent, "candidate");

      await expect(buildClientArtifact(destination)).rejects.toThrow(
        "Destination parent must not be group- or world-writable",
      );
      expect(existsSync(destination)).toBe(false);
    },
  );

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
