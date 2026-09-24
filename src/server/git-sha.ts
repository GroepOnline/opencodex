import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

function readGitHeadSha(): string | null {
  if (!existsSync(join(PACKAGE_ROOT, ".git"))) return null;
  try {
    return (
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: PACKAGE_ROOT,
        encoding: "utf8",
        timeout: 4_000,
        maxBuffer: 256,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" },
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/** npm package fallback: prepack embeds release provenance and installs omit .git. */
export function readPackagedGitSha(): string | null {
  try {
    const raw = readFileSync(
      join(PACKAGE_ROOT, "src", "build-info.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { git_sha?: unknown };
    if (typeof parsed.git_sha !== "string") return null;
    const sha = parsed.git_sha.trim();
    return SHA_PATTERN.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export function resolveGitSha(
  env: NodeJS.ProcessEnv = process.env,
  readGit: () => string | null = readGitHeadSha,
  readPackaged: () => string | null = readPackagedGitSha,
): string | null {
  const fromEnv = env.OPENCODEX_GIT_SHA?.trim();
  if (fromEnv) return fromEnv;
  return readGit() ?? readPackaged();
}

/** Resolved once at module load: env override, else git HEAD, else package build info. */
export const GIT_SHA: string | null = resolveGitSha();
