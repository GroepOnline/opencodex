import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function readGitHeadSha(): string | null {
  if (!existsSync(join(PACKAGE_ROOT, ".git"))) return null;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      timeout: 4_000,
      maxBuffer: 256,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" },
    }).trim() || null;
  } catch {
    return null;
  }
}

/** Resolved once at module load: env override, else git HEAD when .git exists, else null. */
export const GIT_SHA: string | null = (() => {
  const fromEnv = process.env.OPENCODEX_GIT_SHA?.trim();
  if (fromEnv) return fromEnv;
  return readGitHeadSha();
})();
