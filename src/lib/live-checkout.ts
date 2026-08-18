import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { detectInstall } from "../update/index";
import { fileURLToPath } from "node:url";

export interface LiveCheckoutDiagnostic {
  sha: string | null;
  branch: string | null;
  detached: boolean;
  dirty: boolean;
}

const EMPTY_CHECKOUT: LiveCheckoutDiagnostic = {
  sha: null,
  branch: null,
  detached: false,
  dirty: false,
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 4_000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" },
  }).trim();
}

/** Walk up from `startDir` until a `.git` file or directory is found. */
export function findGitCheckout(startDir: string): string | null {
  let dir = resolve(startDir);
  for (let i = 0; i < 16; i++) {
    if (basename(dir) === "node_modules") return null;
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Secret-free live-tree identity. Never include porcelain, diffs, or file lists:
 * those can quote unpublished config (including 3P gateway keys).
 */
export function diagnoseLiveCheckout(startDir?: string): LiveCheckoutDiagnostic {
  if (detectInstall() !== "source") return EMPTY_CHECKOUT;
  const from = startDir ?? fileURLToPath(new URL("../..", import.meta.url));
  const root = findGitCheckout(from);
  if (!root) return EMPTY_CHECKOUT;
  try {
    const sha = git(root, ["rev-parse", "HEAD"]);
    let branch: string | null = null;
    let detached = false;
    try {
      branch = git(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
    } catch {
      detached = true;
      branch = null;
    }
    const porcelain = git(root, ["status", "--porcelain"]);
    return { sha, branch, detached, dirty: porcelain.length > 0 };
  } catch {
    return EMPTY_CHECKOUT;
  }
}

/** Doctor lines. Dirty trees get a `!!` row; never print diff text. */
export function formatLiveCheckoutDoctorLines(checkout: LiveCheckoutDiagnostic): string[] {
  if (!checkout.sha) return ["  --  not a git checkout"];
  const ref = checkout.detached ? "detached" : (checkout.branch ?? "unknown");
  const short = checkout.sha.slice(0, 12);
  if (checkout.dirty) {
    return [
      `  !!  working tree dirty (sha=${short} ${ref})`,
      "       Action: rescue onto a branch and check it out; do not edit the live tree",
    ];
  }
  return [`  ok  ${short} ${ref} clean`];
}
