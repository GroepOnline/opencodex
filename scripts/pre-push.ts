import { hostname } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const LOCAL_OPT_IN = "OCX_RUN_LOCAL_PREPUSH";
const TRUSTED_CI = "CI";
const ISOLATED_BUILD = "OCX_ISOLATED_BUILD";

// Matches the CI verification job budget, while ensuring an opted-in hook cannot wait forever.
export const PREPUSH_TIMEOUT_MS = 40 * 60 * 1_000;

export type PrePushEnvironment = Record<string, string | undefined>;

export function shouldRunPrePush(
  env: PrePushEnvironment = process.env,
): boolean {
  return (
    env[LOCAL_OPT_IN] === "1" ||
    env[TRUSTED_CI] === "true" ||
    env[ISOLATED_BUILD] === "1"
  );
}

export function skipMessage(host = hostname()): string {
  return [
    `pre-push: skipping heavyweight verification on developer host ${host}.`,
    "GitHub-hosted CI or an authorized isolated build must verify the exact head before merge.",
    `For an intentional local run, set ${LOCAL_OPT_IN}=1 and retry.`,
  ].join("\n");
}

export function prePushFailureMessage(error: {
  code?: string;
  message: string;
}): string {
  if (error.code === "ETIMEDOUT") {
    return `pre-push: verification timed out after ${PREPUSH_TIMEOUT_MS / 60_000} minutes; check for orphaned child processes before retrying.`;
  }

  return `pre-push: could not start verification: ${error.message}`;
}

if (import.meta.main) {
  if (!shouldRunPrePush()) {
    console.log(skipMessage());
    process.exit(0);
  }

  const repoRoot = resolve(import.meta.dirname, "..");
  const result = spawnSync("bun", ["run", "prepush"], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    timeout: PREPUSH_TIMEOUT_MS,
  });

  if (result.error) {
    console.error(prePushFailureMessage(result.error));
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}
