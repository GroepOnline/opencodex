#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const outPath = join(root, "src", "build-info.json");

function gitSha(): string | null {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
    if (proc.exitCode !== 0) return null;
    const sha = new TextDecoder().decode(proc.stdout).trim();
    return sha || null;
  } catch {
    return null;
  }
}

function gitRelease(version: string): string | null {
  try {
    const proc = Bun.spawnSync(["git", "describe", "--tags", "--exact-match"], { stdout: "pipe", stderr: "ignore" });
    if (proc.exitCode === 0) {
      const tag = new TextDecoder().decode(proc.stdout).trim();
      if (tag) return tag.startsWith("v") ? tag : `v${tag}`;
    }
  } catch {
    /* no exact tag */
  }
  return version ? `v${version}` : null;
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
const version = typeof pkg.version === "string" ? pkg.version : "0.0.0";

let previous: { gui_version?: string | null } = {};
if (existsSync(outPath)) {
  try {
    previous = JSON.parse(readFileSync(outPath, "utf8")) as typeof previous;
  } catch {
    /* regenerate from scratch */
  }
}

const payload = {
  git_sha: gitSha(),
  built_at: new Date().toISOString(),
  release: gitRelease(version),
  gui_version: version,
};

writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
