import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import {
  prepareRecursiveClaudeLaunch,
  renderRecursiveClaudeShim,
  resolveNativeClaudeCommand,
} from "../src/claude/recursive-launch";

function withTempDir(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "ocx-recursive-claude-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("recursive ocx claude launcher", () => {
  test("prepends an OCX-owned shim while launching the resolved native Claude binary", () => {
    withTempDir(root => {
      const nativeClaude = "/usr/local/bin/claude";
      const launch = prepareRecursiveClaudeLaunch({
        PATH: "/usr/local/bin:/usr/bin",
        ANTHROPIC_AUTH_TOKEN: "secret-never-written",
      }, {
        platform: "linux",
        configDir: root,
        runtimePath: "/opt/opencodex/bun",
        entryPath: "/opt/opencodex/package-main.mjs",
        exists: path => path === nativeClaude,
        isExecutable: path => path === nativeClaude,
      });

      expect(launch.command).toBe(nativeClaude);
      expect(launch.shimPath).not.toBeNull();
      // The launch simulates a posix platform, so paths and PATH entries are
      // posix-shaped even when the test itself runs on Windows. A real temp
      // root can contain a drive-letter colon, so avoid split(":") on PATH.
      expect(launch.shimPath!.startsWith(posix.join(root, "claude-launcher"))).toBe(true);
      expect(launch.shimPath!.endsWith("claude")).toBe(true);
      expect(launch.env.PATH).toBe(`${posix.dirname(launch.shimPath!)}:/usr/local/bin:/usr/bin`);
      expect(launch.env.OPENCODEX_CLAUDE_REAL_COMMAND).toBe(nativeClaude);

      const shim = readFileSync(launch.shimPath!, "utf8");
      expect(shim).toContain(`export OPENCODEX_CLAUDE_REAL_COMMAND='${nativeClaude}'`);
      expect(shim).toContain("package-main.mjs' claude \"$@\"");
      expect(shim).not.toContain("secret-never-written");
      expect(shim).not.toContain("ANTHROPIC_AUTH_TOKEN");
    });
  });

  test("different active installations sharing one config dir cannot overwrite each other", () => {
    withTempDir(root => {
      const firstClaude = "/opt/first/bin/claude";
      const secondClaude = "/opt/second/bin/claude";
      const first = prepareRecursiveClaudeLaunch({ PATH: "/opt/first/bin" }, {
        platform: "linux",
        configDir: root,
        runtimePath: "/opt/first/bun",
        entryPath: "/opt/first/ocx.mjs",
        exists: path => path === firstClaude,
        isExecutable: path => path === firstClaude,
      });
      const firstBefore = readFileSync(first.shimPath!, "utf8");

      const second = prepareRecursiveClaudeLaunch({ PATH: "/opt/second/bin" }, {
        platform: "linux",
        configDir: root,
        runtimePath: "/opt/second/bun",
        entryPath: "/opt/second/ocx.mjs",
        exists: path => path === secondClaude,
        isExecutable: path => path === secondClaude,
      });

      expect(first.shimPath).not.toBe(second.shimPath);
      expect(readFileSync(first.shimPath!, "utf8")).toBe(firstBefore);
      expect(firstBefore).toContain("/opt/first/ocx.mjs");
      expect(readFileSync(second.shimPath!, "utf8")).toContain("/opt/second/ocx.mjs");
      expect(first.env.PATH).toBe(`${posix.dirname(first.shimPath!)}:/opt/first/bin`);
      expect(second.env.PATH).toBe(`${posix.dirname(second.shimPath!)}:/opt/second/bin`);
    });
  });

  test("a shim-started nested launch keeps using the pinned native command", () => {
    const nativeClaude = "/opt/claude/bin/claude";
    const resolved = resolveNativeClaudeCommand({
      PATH: "/tmp/ocx/claude-launcher/hash:/opt/claude/bin",
      OPENCODEX_CLAUDE_REAL_COMMAND: nativeClaude,
    }, "linux", path => path === nativeClaude, path => path === nativeClaude);

    expect(resolved).toBe(nativeClaude);
  });

  test("missing Claude binary preserves the normal command-not-found path without installing a shim", () => {
    withTempDir(root => {
      const launch = prepareRecursiveClaudeLaunch({ PATH: "/usr/bin" }, {
        platform: "linux",
        configDir: root,
        runtimePath: "/opt/bun",
        entryPath: "/opt/ocx.mjs",
        exists: () => false,
        isExecutable: () => false,
      });

      expect(launch.command).toBe("claude");
      expect(launch.shimPath).toBeNull();
      expect(launch.env.PATH).toBe("/usr/bin");
    });
  });

  test("shim write failures do not block the top-level Claude launch", () => {
    withTempDir(root => {
      const launch = prepareRecursiveClaudeLaunch({ PATH: "/bin" }, {
        platform: "linux",
        configDir: root,
        runtimePath: "/opt/bun",
        entryPath: "/opt/ocx.mjs",
        exists: path => path === "/bin/claude",
        isExecutable: path => path === "/bin/claude",
        writeShim: () => { throw new Error("read-only filesystem"); },
      });

      expect(launch.command).toBe("/bin/claude");
      expect(launch.shimPath).toBeNull();
      expect(launch.warning).toContain("read-only filesystem");
    });
  });

  test("Windows resolution and shim preserve cmd launchers and argument forwarding", () => {
    const nativeClaude = "C:\\Users\\joep\\AppData\\Roaming\\npm\\claude.CMD";
    const resolved = resolveNativeClaudeCommand({
      Path: "C:\\Users\\joep\\AppData\\Roaming\\npm;C:\\Windows",
      PATHEXT: ".EXE;.CMD",
    }, "win32", path => path === nativeClaude, path => path === nativeClaude);

    expect(resolved).toBe(nativeClaude);
    const shim = renderRecursiveClaudeShim(
      "win32",
      nativeClaude,
      "C:\\Program Files\\opencodex\\bun.exe",
      "C:\\Program Files\\opencodex\\package-main.mjs",
    );
    expect(shim).toContain(`set "OPENCODEX_CLAUDE_REAL_COMMAND=${nativeClaude}"`);
    expect(shim).toContain('"C:\\Program Files\\opencodex\\bun.exe" "C:\\Program Files\\opencodex\\package-main.mjs" claude %*');
  });
});
