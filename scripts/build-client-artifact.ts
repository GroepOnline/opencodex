import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

/**
 * Determines whether a path is the trusted macOS `/var` alias for `/private/var`.
 *
 * @param path - The logical path to evaluate
 * @param physicalTarget - The path resolved by the filesystem
 * @param platform - The operating-system platform to evaluate
 * @returns `true` if the values represent the macOS `/var` to `/private/var` alias, `false` otherwise
 */
export function isTrustedDarwinSystemPathAlias(
  path: string,
  physicalTarget: string,
  platform = process.platform,
) {
  return (
    platform === "darwin" && path === "/var" && physicalTarget === "/private/var"
  );
}

/**
 * Ensures that an existing component of a path is not a symbolic link, except for the trusted macOS `/var` alias.
 *
 * Missing path components are allowed.
 *
 * @param path - The path whose components to inspect
 */
function assertNoSymlinkPathComponents(path: string) {
  let current = resolve(path);
  while (true) {
    try {
      if (
        lstatSync(current).isSymbolicLink() &&
        !isTrustedDarwinSystemPathAlias(current, realpathSync(current))
      ) {
        throw new Error(
          `Destination path traverses a symlink; refusing publication: ${current}`,
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        // Missing components are expected for a fresh candidate path.
      } else {
        throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

type PublicationParentIdentity = { dev: number; ino: number; uid: number };

function assertTrustedPublicationParent(
  parentPath: string,
  expected?: PublicationParentIdentity,
): PublicationParentIdentity {
  assertNoSymlinkPathComponents(parentPath);
  const stats = lstatSync(parentPath);
  if (!stats.isDirectory()) {
    throw new Error(`Destination parent is not a directory: ${parentPath}`);
  }
  if (process.platform !== "win32") {
    const currentUid =
      typeof process.getuid === "function" ? process.getuid() : stats.uid;
    if (stats.uid !== currentUid) {
      throw new Error(
        `Destination parent must be owned by the current user: ${parentPath}`,
      );
    }
    if ((stats.mode & 0o022) !== 0) {
      throw new Error(
        `Destination parent must not be group- or world-writable: ${parentPath}`,
      );
    }
  }
  const identity = { dev: stats.dev, ino: stats.ino, uid: stats.uid };
  if (
    expected &&
    (identity.dev !== expected.dev ||
      identity.ino !== expected.ino ||
      identity.uid !== expected.uid)
  ) {
    throw new Error(
      "Destination parent changed during build; refusing publication",
    );
  }
  return identity;
}

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success) throw new Error(`git ${args[0]} failed`);
  return result.stdout.toString().trim();
}

function normalizeGeneratedBundleSourceComments(
  bundle: Uint8Array,
  buildRoot: string,
): Uint8Array {
  const marker = basename(buildRoot);
  const text = new TextDecoder().decode(bundle);
  const normalized = text
    .split("\n")
    .map((line) => {
      if (!line.includes(marker)) return line;
      if (!line.trimStart().startsWith("// ")) {
        throw new Error(
          "Temporary build path escaped generated source comments; refusing nondeterministic artifact",
        );
      }
      return line.replaceAll(marker, "ocx-client-source");
    })
    .join("\n");
  if (normalized.includes(marker)) {
    throw new Error(
      "Temporary build path remained in bundle after normalization; refusing nondeterministic artifact",
    );
  }
  return new TextEncoder().encode(normalized);
}

/**
 * Creates an isolated build worktree at a source revision with frozen dependencies installed.
 *
 * @param sourceRoot - The Git repository containing the source revision
 * @param sourceSha - The commit SHA to check out
 * @returns The path to the isolated build worktree
 * @throws If worktree creation or dependency installation fails
 */
function prepareIsolatedBuildRoot(
  sourceRoot: string,
  sourceSha: string,
): string {
  const buildRoot = mkdtempSync(join(tmpdir(), "ocx-client-source-"));
  try {
    git(
      sourceRoot,
      "worktree",
      "add",
      "--detach",
      "--force",
      "--quiet",
      buildRoot,
      sourceSha,
    );
    const install = Bun.spawnSync(
      [
        process.execPath,
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--force",
      ],
      { cwd: buildRoot, stdout: "pipe", stderr: "pipe" },
    );
    if (!install.success) {
      throw new Error(
        `Locked dependency refresh failed; refusing artifact build: ${install.stderr.toString().trim()}`,
      );
    }
    return buildRoot;
  } catch (error) {
    Bun.spawnSync(["git", "worktree", "remove", "--force", buildRoot], {
      cwd: sourceRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    rmSync(buildRoot, { recursive: true, force: true });
    throw error;
  }
}

function removeIsolatedBuildRoot(sourceRoot: string, buildRoot: string) {
  Bun.spawnSync(["git", "worktree", "remove", "--force", buildRoot], {
    cwd: sourceRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  rmSync(buildRoot, { recursive: true, force: true });
}

// The remote wrapper owns all mutation and lifecycle behavior. Direct bundle use
// stops before the CLI's auto-repair hooks can run.
export const CLIENT_GUARD = `
const clientCommand = process.argv[2] || "";
const clientReadOnlyCommands = new Set(["", "help", "--help", "-h", "version", "--version", "-v"]);
if (!clientReadOnlyCommands.has(clientCommand)) {
  console.error("OCX client artifact: local lifecycle commands are disabled; use the remote launcher.");
  process.exit(64);
}
`;

export const CODEX_CLIENT_SHIM = [
  "#!/usr/bin/env sh",
  "# OpenCodex client-only Codex shim. The proxy remains remote; this only selects an isolated Codex home.",
  "set -eu",
  'home_dir="$(cd -P -- "${HOME:?HOME is required}" && pwd -P)" || {',
  '  echo "OCX client-only: HOME must name an accessible directory" >&2',
  "  exit 78",
  "}",
  'native_home="${home_dir%/}/.codex"',
  'if [ -e "$native_home" ] || [ -L "$native_home" ]; then',
  '  native_home="$(cd -P -- "$native_home" && pwd -P)" || {',
  '    echo "OCX client-only: native Codex home must resolve to an accessible directory" >&2',
  "    exit 78",
  "  }",
  "fi",
  'client_home="${OCX_CLIENT_CODEX_HOME:-${home_dir%/}/.codex-ocx}"',
  'case "$client_home" in',
  "  /*) ;;",
  '  *) echo "OCX client-only: OCX_CLIENT_CODEX_HOME must be absolute" >&2; exit 78 ;;',
  "esac",
  'client_home="$(printf "%s\\n" "$client_home" | awk -F/ \'{',
  "  n = 0;",
  "  for (i = 1; i <= NF; i++) {",
  '    if ($i == "" || $i == ".") continue;',
  '    if ($i == "..") { if (n > 0) n--; continue; }',
  "    parts[++n] = $i;",
  "  }",
  '  out = "/";',
  '  for (i = 1; i <= n; i++) out = out (i == 1 ? "" : "/") parts[i];',
  "  print out;",
  "}')\"",
  'path_part=""',
  'path_rest="${client_home#/}"',
  'while [ -n "$path_rest" ]; do',
  '  path_component="${path_rest%%/*}"',
  '  if [ "$path_rest" = "$path_component" ]; then path_rest=""; else path_rest="${path_rest#*/}"; fi',
  '  [ -n "$path_component" ] || continue',
  '  path_part="${path_part}/${path_component}"',
  '  if [ -L "$path_part" ]; then',
  '    # macOS exposes /var as the system-owned alias of /private/var. It is the',
  '    # sole symlink component allowed here; every other link remains forbidden.',
  '    if [ "$path_part" = "/var" ] && [ "$(uname -s)" = "Darwin" ] && [ "$(cd -P -- "$path_part" && pwd -P)" = "/private/var" ]; then continue; fi',
  '    echo "OCX client-only: refusing symlinked Codex home path $path_part" >&2',
  "    exit 78",
  "  fi",
  "done",
  'if [ -e "$client_home" ]; then',
  '  client_home="$(cd -P -- "$client_home" && pwd -P)" || {',
  '    echo "OCX client-only: client Codex home must resolve to an accessible directory" >&2',
  "    exit 78",
  "  }",
  "fi",
  'case "$client_home" in',
  '  "$native_home"|"$native_home"/*)',
  '    echo "OCX client-only: refusing native Codex home $native_home" >&2',
  "    exit 78",
  "    ;;",
  "esac",
  'export CODEX_HOME="$client_home"',
  'token_file="${OCX_CLIENT_TOKEN_FILE:-${home_dir%/}/.opencodex/service-api-token}"',
  'if [ -z "${OPENCODEX_API_KEY:-}" ] && [ -f "$token_file" ]; then',
  '  OPENCODEX_API_KEY="$(cat "$token_file")"',
  "  export OPENCODEX_API_KEY",
  "fi",
  'if [ -z "${OPENCODEX_API_AUTH_TOKEN:-}" ] && [ -n "${OPENCODEX_API_KEY:-}" ]; then',
  '  OPENCODEX_API_AUTH_TOKEN="$OPENCODEX_API_KEY"',
  "  export OPENCODEX_API_AUTH_TOKEN",
  "fi",
  'ocx_bin="${OCX_CLIENT_OCX_BIN:-${home_dir%/}/.local/bin/ocx}"',
  'codex_bin="${OCX_CLIENT_CODEX_BIN:-${home_dir%/}/.local/bin/codex.opencodex-real}"',
  'case "${1:-}" in',
  "  agents|app-server|apply|cloud|completion|doctor|exec-server|features|help|login|logout|mcp-server|plugin|remote-control|update|--help|-h|--version|-V|debug) ;;",
  "  *)",
  '    "$ocx_bin" ensure >/dev/null 2>&1 || {',
  '      echo "Codex: central OCX proxy unavailable through the governed remote launcher" >&2',
  "      exit 69",
  "    }",
  "    ;;",
  "esac",
  'exec "$codex_bin" "$@"',
  "",
].join("\n");

export const CODEX_CLIENT_POWERSHELL_SHIM = [
  "# OpenCodex client-only Codex shim for PowerShell.",
  "$ErrorActionPreference = 'Stop'",
  "$homeRoot = if (-not [string]::IsNullOrWhiteSpace($env:HOME)) { $env:HOME } elseif (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) { $env:USERPROFILE } else { [Console]::Error.WriteLine('OCX client-only: HOME or USERPROFILE is required'); exit 78 }",
  "$homeDir = [System.IO.Path]::GetFullPath($homeRoot)",
  "function Resolve-PhysicalPath([string]$Path, [int]$Depth = 0) {",
  "  if ($Depth -gt 40) { throw 'OCX client-only: reparse-point resolution exceeded the safe depth' }",
  "  $full = [System.IO.Path]::GetFullPath($Path)",
  "  $root = [System.IO.Path]::GetPathRoot($full)",
  "  $current = $root",
  "  $relative = $full.Substring($root.Length).Split([char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar), [System.StringSplitOptions]::RemoveEmptyEntries)",
  "  foreach ($part in $relative) {",
  "    $candidate = Join-Path $current $part",
  "    $item = Get-Item -Force -LiteralPath $candidate -ErrorAction SilentlyContinue",
  "    if ($null -eq $item) { $current = $candidate; continue }",
  "    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {",
  "      $resolver = $item.PSObject.Methods['ResolveLinkTarget']",
  "      if ($null -ne $resolver) {",
  "        $target = $item.ResolveLinkTarget($true)",
  '        if ($null -eq $target) { throw "OCX client-only: cannot resolve reparse point $candidate" }',
  "        $targetPath = $target.FullName",
  "      } else {",
  "        $targets = @($item.Target)",
  '        if ($targets.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$targets[0])) { throw "OCX client-only: cannot resolve reparse point $candidate" }',
  "        $targetPath = [string]$targets[0]",
  "        if (-not [System.IO.Path]::IsPathRooted($targetPath)) { $targetPath = Join-Path (Split-Path -Parent $candidate) $targetPath }",
  "      }",
  "      $current = Resolve-PhysicalPath $targetPath ($Depth + 1)",
  "    } else { $current = $candidate }",
  "  }",
  "  return [System.IO.Path]::GetFullPath($current)",
  "}",
  "function Test-TrustedDarwinSystemPathAlias([string]$Path) {",
  "  if (-not $IsMacOS -or $Path -ne '/var') { return $false }",
  "  try { return [string]::Equals((Resolve-PhysicalPath $Path), '/private/var', [System.StringComparison]::Ordinal) } catch { return $false }",
  "}",
  "$clientHomeRaw = if ($env:OCX_CLIENT_CODEX_HOME) { $env:OCX_CLIENT_CODEX_HOME } else { Join-Path $homeDir '.codex-ocx' }",
  "if (-not [System.IO.Path]::IsPathRooted($clientHomeRaw)) { [Console]::Error.WriteLine('OCX client-only: OCX_CLIENT_CODEX_HOME must be absolute'); exit 78 }",
  "$clientHomeCandidate = [System.IO.Path]::GetFullPath($clientHomeRaw)",
  "function Test-ReparsePointPath([string]$Path) {",
  "  $root = [System.IO.Path]::GetPathRoot($Path)",
  "  $current = $root",
  "  $relative = $Path.Substring($root.Length).Split([char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar), [System.StringSplitOptions]::RemoveEmptyEntries)",
  "  foreach ($part in $relative) {",
  "    $current = Join-Path $current $part",
  "    $item = Get-Item -Force -LiteralPath $current -ErrorAction SilentlyContinue",
  "    if ($null -ne $item) {",
  "      if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {",
  "        if (Test-TrustedDarwinSystemPathAlias $current) { continue }",
  "        return $true",
  "      }",
  "    }",
  "  }",
  "  return $false",
  "}",
  "try {",
  "  $nativeHome = Resolve-PhysicalPath (Join-Path $homeDir '.codex')",
  "  $clientHome = Resolve-PhysicalPath $clientHomeCandidate",
  "} catch {",
  '  [Console]::Error.WriteLine("OCX client-only: cannot resolve Codex home: $($_.Exception.Message)")',
  "  exit 78",
  "}",
  "if ([string]::Equals($clientHome, $nativeHome, [System.StringComparison]::OrdinalIgnoreCase) -or $clientHome.StartsWith($nativeHome + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -or (Test-ReparsePointPath $clientHomeCandidate)) {",
  '  [Console]::Error.WriteLine("OCX client-only: refusing native or symlinked Codex home $clientHomeCandidate")',
  "  exit 78",
  "}",
  "$env:CODEX_HOME = $clientHome",
  "$tokenFile = if ($env:OCX_CLIENT_TOKEN_FILE) { $env:OCX_CLIENT_TOKEN_FILE } else { Join-Path $homeDir '.opencodex\\service-api-token' }",
  "if (-not $env:OPENCODEX_API_KEY -and (Test-Path -LiteralPath $tokenFile -PathType Leaf)) { $env:OPENCODEX_API_KEY = (Get-Content -Raw -LiteralPath $tokenFile).Trim() }",
  "if (-not $env:OPENCODEX_API_AUTH_TOKEN -and $env:OPENCODEX_API_KEY) { $env:OPENCODEX_API_AUTH_TOKEN = $env:OPENCODEX_API_KEY }",
  "$ocxBin = if ($env:OCX_CLIENT_OCX_BIN) { $env:OCX_CLIENT_OCX_BIN } else { Join-Path $homeDir '.local\\bin\\ocx.cmd' }",
  "$codexBin = if ($env:OCX_CLIENT_CODEX_BIN) { $env:OCX_CLIENT_CODEX_BIN } else { Join-Path $homeDir '.local\\bin\\codex.opencodex-real.cmd' }",
  "$skipEnsure = @('agents', 'app-server', 'apply', 'cloud', 'completion', 'doctor', 'exec-server', 'features', 'help', 'login', 'logout', 'mcp-server', 'plugin', 'remote-control', 'update', '--help', '-h', '--version', '-V', 'debug') -contains ($args | Select-Object -First 1)",
  "if (-not $skipEnsure) { & $ocxBin ensure *> $null; if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine('Codex: central OCX proxy unavailable through the governed remote launcher'); exit 69 } }",
  "& $codexBin @args",
  "exit $LASTEXITCODE",
  "",
].join("\r\n");

/**
 * Builds and publishes a client artifact from clean, committed runtime inputs.
 *
 * @param destination - Destination directory for the new artifact candidate
 * @param root - Runtime source repository to build from
 * @returns The generated artifact manifest
 */
export async function buildClientArtifact(destination: string, root = ROOT) {
  const builderDirty = git(
    ROOT,
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    "scripts/build-client-artifact.ts",
  );
  if (builderDirty)
    throw new Error(
      "Artifact builder is dirty; commit the reviewed builder before building",
    );
  const builderSourceSha = git(ROOT, "rev-parse", "HEAD");
  const output = resolve(destination);
  if (existsSync(output))
    throw new Error(
      "Destination already exists; build a new candidate instead",
    );
  assertNoSymlinkPathComponents(output);
  // Build only clean, tracked runtime inputs. Tooling/docs edits do not invalidate
  // the runtime revision; package metadata is read from the exact Git object.
  const dirty = git(
    root,
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    "src",
    "bun.lock",
  );
  if (dirty)
    throw new Error(
      "Runtime inputs are dirty; commit or isolate them before building",
    );
  const sourceSha = git(root, "rev-parse", "HEAD");
  const packageText = git(root, "show", `${sourceSha}:package.json`) + "\n";
  const lock = readFileSync(join(root, "bun.lock"));
  const publicationParent = dirname(output);
  mkdirSync(publicationParent, { recursive: true, mode: 0o700 });
  const publicationParentIdentity =
    assertTrustedPublicationParent(publicationParent);
  // Bundle from an isolated clean clone so the artifact is a function of the
  // reviewed source + frozen lock, never of ignored/tampered node_modules in
  // the caller checkout. The source checkout remains read-only. Validate the
  // publication parent first so unsafe destinations fail before dependency I/O.
  const buildRoot = prepareIsolatedBuildRoot(root, sourceSha);
  let staging: string;
  try {
    staging = mkdtempSync(join(publicationParent, ".ocx-client-build-"));
  } catch (error) {
    removeIsolatedBuildRoot(root, buildRoot);
    throw error;
  }
  try {
    const result = await Bun.build({
      entrypoints: [join(buildRoot, "src/cli/index.ts")],
      root: buildRoot,
      target: "bun",
      format: "esm",
      packages: "bundle",
      splitting: false,
      sourcemap: "none",
      banner: CLIENT_GUARD,
    });
    if (!result.success)
      throw new Error(
        `Client bundle failed: ${result.logs.map(String).join("\n")}`,
      );
    if (result.outputs.length !== 1)
      throw new Error(
        "Unexpected bundle assets; extend the artifact manifest before shipping",
      );
    const rawBundle = new Uint8Array(await result.outputs[0]!.arrayBuffer());
    const bundle = normalizeGeneratedBundleSourceComments(rawBundle, buildRoot);
    const digest = sha256(bundle);
    mkdirSync(join(staging, "src/cli"), { recursive: true });
    writeFileSync(join(staging, "src/cli/index.js"), bundle);
    mkdirSync(join(staging, "bin"));
    writeFileSync(join(staging, "bin/codex.ocx-client"), CODEX_CLIENT_SHIM, {
      mode: 0o755,
    });
    chmodSync(join(staging, "bin/codex.ocx-client"), 0o755);
    writeFileSync(
      join(staging, "bin/codex.ocx-client.ps1"),
      CODEX_CLIENT_POWERSHELL_SHIM,
    );
    // Package metadata is read relative to src/cli/index.js by the CLI.
    // The upstream model JSON and imported dependencies are bundled by Bun.
    writeFileSync(join(staging, "package.json"), packageText);
    writeFileSync(join(staging, "source-sha"), sourceSha + "\n");
    writeFileSync(
      join(staging, "index.js.sha256"),
      `${digest}  src/cli/index.js\n`,
    );
    const manifest = {
      format: "ocx-remote-client-v1",
      sourceSha,
      bunVersion: Bun.version,
      lockSha256: sha256(lock),
      builderSourceSha,
      builderSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
      files: {
        "src/cli/index.js": digest,
        "bin/codex.ocx-client": sha256(CODEX_CLIENT_SHIM),
        "bin/codex.ocx-client.ps1": sha256(CODEX_CLIENT_POWERSHELL_SHIM),
        "package.json": sha256(packageText),
      },
      activation: "not-activated",
    };
    writeFileSync(
      join(staging, "artifact-manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    // Never touch `current`; publication creates one new candidate directory.
    // The parent is owned by this user and not group/world-writable, so no
    // unprivileged peer can swap its entries between this identity check and
    // the same-directory rename. Re-check both confinement and inode identity
    // after the potentially long bundle build before publishing.
    assertTrustedPublicationParent(
      publicationParent,
      publicationParentIdentity,
    );
    assertNoSymlinkPathComponents(output);
    if (existsSync(output))
      throw new Error(
        "Destination appeared during build; refusing replacement",
      );
    renameSync(staging, output);
    return manifest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    removeIsolatedBuildRoot(root, buildRoot);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output");
  const sourceIndex = args.indexOf("--source-root");
  const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  const sourceRoot = sourceIndex >= 0 ? args[sourceIndex + 1] : ROOT;
  const knownArgs = new Set(["--output", "--source-root"]);
  const flags = args.filter((arg) => arg.startsWith("--"));
  const expectedLength = sourceIndex >= 0 ? 4 : 2;
  if (
    !output ||
    !sourceRoot ||
    args.length !== expectedLength ||
    flags.some((flag) => !knownArgs.has(flag))
  ) {
    console.error(
      "Usage: bun run build:client --output <new-candidate-directory> [--source-root <clean-checkout>]",
    );
    process.exitCode = 2;
  } else {
    try {
      console.log(
        JSON.stringify(
          await buildClientArtifact(output, resolve(sourceRoot)),
          null,
          2,
        ),
      );
    } catch (error) {
      console.error(
        error instanceof Error ? error.message : "Client artifact build failed",
      );
      process.exitCode = 1;
    }
  }
}
