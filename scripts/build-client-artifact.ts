import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success) throw new Error(`git ${args[0]} failed`);
  return result.stdout.toString().trim();
}

// The remote wrapper intercepts lifecycle commands; reject direct bundle use too.
export const CLIENT_GUARD = `
const clientCommand = process.argv[2] || "";
if (["start", "stop", "restart", "ensure", "service", "gui", "init", "setup", "uninstall", "remove", "update", "tray", "restore", "eject", "proxy", "daemon"].includes(clientCommand) || clientCommand.startsWith("__")) {
  console.error("OCX client artifact: local lifecycle commands are disabled; use the remote launcher.");
  process.exit(64);
}
`;

export const CODEX_CLIENT_SHIM = [
  "#!/usr/bin/env sh",
  "# OpenCodex client-only Codex shim. The proxy remains remote; this only selects an isolated Codex home.",
  "set -eu",
  'home_dir="${HOME:?HOME is required}"',
  'native_home="${home_dir%/}/.codex"',
  'client_home="${OCX_CLIENT_CODEX_HOME:-${home_dir%/}/.codex-ocx}"',
  'client_home="${client_home%/}"',
  'if [ "$client_home" = "$native_home" ]; then',
  '  echo "OCX client-only: refusing native Codex home $native_home" >&2',
  "  exit 78",
  "fi",
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

export async function buildClientArtifact(destination: string, root = ROOT) {
  const output = resolve(destination);
  if (existsSync(output))
    throw new Error(
      "Destination already exists; build a new candidate instead",
    );
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
  mkdirSync(dirname(output), { recursive: true });
  const staging = mkdtempSync(join(dirname(output), ".ocx-client-build-"));
  try {
    const result = await Bun.build({
      entrypoints: [join(root, "src/cli/index.ts")],
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
    const bundle = new Uint8Array(await result.outputs[0]!.arrayBuffer());
    const digest = sha256(bundle);
    mkdirSync(join(staging, "src/cli"), { recursive: true });
    writeFileSync(join(staging, "src/cli/index.js"), bundle);
    mkdirSync(join(staging, "bin"));
    writeFileSync(join(staging, "bin/codex.ocx-client"), CODEX_CLIENT_SHIM, {
      mode: 0o755,
    });
    chmodSync(join(staging, "bin/codex.ocx-client"), 0o755);
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
      builderSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
      files: {
        "src/cli/index.js": digest,
        "bin/codex.ocx-client": sha256(CODEX_CLIENT_SHIM),
        "package.json": sha256(packageText),
      },
      activation: "not-activated",
    };
    writeFileSync(
      join(staging, "artifact-manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    // Never touch `current`; publication creates one new candidate directory.
    if (existsSync(output))
      throw new Error(
        "Destination appeared during build; refusing replacement",
      );
    renameSync(staging, output);
    return manifest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
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
