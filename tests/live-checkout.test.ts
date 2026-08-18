import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectStartupHealth } from "../src/codex/autostart-health";
import {
  diagnoseLiveCheckout,
  formatLiveCheckoutDoctorLines,
} from "../src/lib/live-checkout";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "ocx-test",
      GIT_AUTHOR_EMAIL: "ocx-test@example.test",
      GIT_COMMITTER_NAME: "ocx-test",
      GIT_COMMITTER_EMAIL: "ocx-test@example.test",
    },
  }).trim();
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-live-checkout-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "ocx-test@example.test"]);
  git(dir, ["config", "user.name", "ocx-test"]);
  git(dir, ["commit", "--allow-empty", "-m", "init"]);
  return dir;
}

describe("diagnoseLiveCheckout", () => {
  test("reports a clean named branch without diff text", () => {
    const dir = initRepo();
    try {
      const checkout = diagnoseLiveCheckout(dir);
      expect(checkout.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(checkout.branch).toBe("main");
      expect(checkout.detached).toBe(false);
      expect(checkout.dirty).toBe(false);
      expect(JSON.stringify(checkout)).not.toContain("diff --git");
      expect(formatLiveCheckoutDoctorLines(checkout)[0]).toMatch(/^ {2}ok {2}/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("flags a dirty tree with a !! doctor line and no porcelain listing", () => {
    const dir = initRepo();
    try {
      writeFileSync(join(dir, "snowflake.txt"), "unpublished\n");
      const checkout = diagnoseLiveCheckout(dir);
      expect(checkout.dirty).toBe(true);
      expect(checkout.branch).toBe("main");
      const encoded = JSON.stringify(checkout);
      expect(encoded).not.toContain("snowflake.txt");
      expect(encoded).not.toContain("unpublished");
      expect(encoded).not.toContain("diff --git");
      const lines = formatLiveCheckoutDoctorLines(checkout);
      expect(lines[0]).toMatch(/^ {2}!! {2}working tree dirty /);
      expect(lines.join("\n")).not.toContain("snowflake.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports detached HEAD without calling it a branch", () => {
    const dir = initRepo();
    try {
      git(dir, ["checkout", "--detach"]);
      const checkout = diagnoseLiveCheckout(dir);
      expect(checkout.detached).toBe(true);
      expect(checkout.branch).toBeNull();
      expect(checkout.dirty).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not walk past node_modules into a consumer repository", () => {
    const consumer = initRepo();
    const packageRoot = join(consumer, "node_modules", "opencodex");
    try {
      mkdirSync(packageRoot, { recursive: true });
      const checkout = diagnoseLiveCheckout(packageRoot);
      expect(checkout.sha).toBeNull();
      expect(checkout.dirty).toBe(false);
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  test("collectStartupHealth includes liveCheckout without diffs", () => {
    const health = collectStartupHealth({ codexAutoStart: true });
    expect(health.liveCheckout).toEqual(expect.objectContaining({
      detached: expect.any(Boolean),
      dirty: expect.any(Boolean),
    }));
    expect(JSON.stringify(health.liveCheckout)).not.toContain("diff --git");
  });
});

describe("assert-live-checkout-safe.sh", () => {
  const script = join(import.meta.dir, "../scripts/assert-live-checkout-safe.sh");

  test("refuses dirty porcelain and a HEAD that is not an ancestor of the target", () => {
    if (!Bun.which("bash")) return;
    const dir = initRepo();
    try {
      const clean = Bun.spawnSync(["bash", script, dir], { stdout: "pipe", stderr: "pipe" });
      expect(clean.exitCode).toBe(0);

      writeFileSync(join(dir, "dirty.txt"), "no\n");
      const dirty = Bun.spawnSync(["bash", script, dir], { stdout: "pipe", stderr: "pipe" });
      expect(dirty.exitCode).toBe(1);
      expect(dirty.stderr.toString()).toContain("refusing dirty working tree");
      expect(dirty.stderr.toString()).not.toContain("dirty.txt");
      rmSync(join(dir, "dirty.txt"), { force: true });
      const first = git(dir, ["rev-parse", "HEAD"]);
      git(dir, ["commit", "--allow-empty", "-m", "second"]);
      const second = git(dir, ["rev-parse", "HEAD"]);

      const ancestor = Bun.spawnSync(["bash", script, dir, second], { stdout: "pipe", stderr: "pipe" });
      expect(ancestor.exitCode).toBe(0);

      git(dir, ["checkout", "-q", first]);
      const wouldDrop = Bun.spawnSync(["bash", script, dir, first], { stdout: "pipe", stderr: "pipe" });
      // HEAD is first; target first is ancestor of itself — allowed.
      expect(wouldDrop.exitCode).toBe(0);

      git(dir, ["checkout", "-q", second]);
      const notAncestor = Bun.spawnSync(["bash", script, dir, first], { stdout: "pipe", stderr: "pipe" });
      expect(notAncestor.exitCode).toBe(1);
      expect(notAncestor.stderr.toString()).toContain("would drop live-only commits");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("exits 2 when git status probe fails without printing porcelain", () => {
    if (!Bun.which("bash")) return;
    const dir = initRepo();
    try {
      const realGit = Bun.which("git");
      if (!realGit) return;
      const binDir = mkdtempSync(join(tmpdir(), "ocx-live-checkout-bin-"));
      writeFileSync(join(binDir, "git"), `#!/usr/bin/env bash
if [[ "$1" == "status" && "$2" == "--porcelain" ]]; then
  exit 1
fi
exec "${realGit}" "$@"
`);
      chmodSync(join(binDir, "git"), 0o755);
      const probe = Bun.spawnSync(["bash", script, dir], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      });
      expect(probe.exitCode).toBe(2);
      expect(probe.stderr.toString()).toContain("git status probe failed");
      expect(probe.stdout.toString()).toBe("");
      expect(probe.stderr.toString()).not.toContain("??");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
