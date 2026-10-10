import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertClaudeDesktopProtocolUri,
  getClaudeDesktopProtocolStatus,
  installClaudeDesktopProtocol,
  repairClaudeDesktopProtocol,
  uninstallClaudeDesktopProtocol,
  type DesktopProtocolOptions,
} from "../src/claude/desktop-protocol";
import { handleClaudeDesktopCommand } from "../src/cli/claude-desktop";

// Decode the Desktop Entry string layer, then its quoted Exec argv layer; never invoke a shell.
function decodeExec(text: string): string[] {
  const line = text.split("\n").find(line => line.startsWith("Exec="))!.slice(5);
  const escapes: Record<string, string> = { s: " ", n: "\n", t: "\t", r: "\r", "\\": "\\" };
  const decoded = line.replace(/\\(.)/g, (_, char: string) => {
    if (!(char in escapes)) throw new Error("Invalid Desktop Entry escape");
    return escapes[char]!;
  });
  const args: string[] = [];
  let argument = "";
  let quoted = false;
  for (let index = 0; index < decoded.length; index++) {
    const char = decoded[index]!;
    if (char === "\\") argument += decoded[++index];
    else if (char === '"') quoted = !quoted;
    else if (char === " " && !quoted) { args.push(argument.replace(/%%/g, "%")); argument = ""; }
    else argument += char;
  }
  if (quoted) throw new Error("Unclosed Exec argument");
  args.push(argument.replace(/%%/g, "%"));
  return args;
}

let root: string;
let options: DesktopProtocolOptions;
let commands: Array<[string, string[]]>;
let desktopPath: string;
let statePath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-desktop-protocol-"));
  const runtimePath = join(root, "runtime");
  const cliPath = join(root, "index.ts");
  writeFileSync(runtimePath, "fixture runtime\n", { mode: 0o700 });
  writeFileSync(cliPath, "fixture CLI\n");
  commands = [];
  options = { platform: "linux", dataHome: join(root, "xdg"), configDir: join(root, "ocx"),
    runtimePath, cliPath, execCommand: (file, args) => { commands.push([file, [...args]]); } };
  desktopPath = join(options.dataHome!, "applications", "ocx-desktop.desktop");
  statePath = join(options.configDir!, "claude-desktop-protocol.json");
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function file(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

function installedFiles(): [string, string] {
  return [readFileSync(desktopPath, "utf8"), readFileSync(statePath, "utf8")];
}

const linuxDescribe = process.platform === "linux" ? describe : describe.skip;

linuxDescribe("Claude Desktop protocol installation", () => {
  test("absent status and skipped repair do not create directories or invoke XDG", () => {
    expect(getClaudeDesktopProtocolStatus(options).status).toBe("absent");
    expect(repairClaudeDesktopProtocol(options).status).toBe("skipped");
    expect(uninstallClaudeDesktopProtocol(options).status).toBe("absent");
    expect(existsSync(options.configDir!)).toBe(false);
    expect(existsSync(options.dataHome!)).toBe(false);
    expect(commands).toEqual([]);
  });

  test("installs versioned owned files with deterministic absolute Exec argv and XDG registration", () => {
    expect(installClaudeDesktopProtocol(options)).toEqual({ status: "installed", desktopPath, statePath });
    expect(commands).toEqual([["xdg-mime", ["default", "ocx-desktop.desktop", "x-scheme-handler/ocx-desktop"]]]);
    const [desktop, state] = installedFiles();
    expect(decodeExec(desktop)).toEqual([options.runtimePath!, options.cliPath!, "claude", "desktop", "protocol", "dispatch", "%u"]);
    expect(desktop).toContain("X-OCX-Protocol-Version=1\n");
    expect(desktop).toContain("MimeType=x-scheme-handler/ocx-desktop;\n");
    expect(JSON.parse(state)).toEqual({ version: 1, owner: "opencodex/claude-desktop-protocol",
      desktopPath, runtimePath: options.runtimePath, cliPath: options.cliPath, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(lstatSync(statePath).mode & 0o777).toBe(0o600);
    expect(getClaudeDesktopProtocolStatus(options).status).toBe("installed");
  });

  test("idempotent install preserves bytes/inodes and can repeat failed XDG registration", () => {
    installClaudeDesktopProtocol(options);
    const bytes = installedFiles();
    const inode = lstatSync(desktopPath).ino;
    expect(installClaudeDesktopProtocol(options).status).toBe("unchanged");
    expect(installedFiles()).toEqual(bytes);
    expect(lstatSync(desktopPath).ino).toBe(inode);
    expect(commands).toHaveLength(2);
    expect(repairClaudeDesktopProtocol(options).status).toBe("unchanged");
    expect(commands).toHaveLength(2);
  });

  test("correctly escapes spaces, quotes, backslashes, dollar/backtick and literal percent codes", () => {
    const odd = join(root, 'space "quote" \\ $HOME `tick`; &|<>*?#()');
    mkdirSync(odd);
    options.runtimePath = join(odd, "bun");
    options.cliPath = join(odd, "cli=index %u %F.ts");
    writeFileSync(options.runtimePath, "fixture", { mode: 0o700 });
    writeFileSync(options.cliPath, "fixture");
    installClaudeDesktopProtocol(options);
    const desktop = readFileSync(desktopPath, "utf8");
    expect(decodeExec(desktop)).toEqual([options.runtimePath, options.cliPath, "claude", "desktop", "protocol", "dispatch", "%u"]);
    expect(desktop).toContain("%%u %%F");
    expect(desktop).not.toContain("sh -c");
    expect(desktop).not.toContain("bash");
  });

  test("resolves runtime and CLI symlinks to durable absolute targets, not PATH commands", () => {
    const runtimeLink = join(root, "bun-link");
    const cliLink = join(root, "cli-link");
    symlinkSync(options.runtimePath!, runtimeLink);
    symlinkSync(options.cliPath!, cliLink);
    installClaudeDesktopProtocol({ ...options, runtimePath: runtimeLink, cliPath: cliLink });
    expect(decodeExec(readFileSync(desktopPath, "utf8")).slice(0, 2)).toEqual([options.runtimePath!, options.cliPath!]);
  });

  test("resolves symlinked runtime ancestors and bounds circular links before writing", () => {
    const actualDir = join(root, "runtime-dir");
    mkdirSync(actualDir);
    const runtimePath = join(actualDir, "bun");
    writeFileSync(runtimePath, "fixture", { mode: 0o700 });
    const aliasDir = join(root, "runtime-alias");
    symlinkSync(actualDir, aliasDir);
    installClaudeDesktopProtocol({ ...options, runtimePath: join(aliasDir, "bun") });
    expect(decodeExec(readFileSync(desktopPath, "utf8"))[0]).toBe(runtimePath);
    const before = installedFiles();
    const loopA = join(root, "loop-a");
    const loopB = join(root, "loop-b");
    symlinkSync(loopB, loopA);
    symlinkSync(loopA, loopB);
    expect(() => repairClaudeDesktopProtocol({ ...options, runtimePath: loopA })).toThrow("too many symbolic links");
    expect(installedFiles()).toEqual(before);
    expect(commands).toHaveLength(1);
  });

  test("refuses invalid directory paths, unsafe executable path and non-executable runtime", () => {
    for (const dataHome of ["relative", `${root}/../different`, `${root}/bad\npath`]) {
      expect(() => installClaudeDesktopProtocol({ ...options, dataHome })).toThrow("absolute paths");
    }
    const equalsRuntime = join(root, "bun=runtime");
    writeFileSync(equalsRuntime, "fixture", { mode: 0o700 });
    expect(() => installClaudeDesktopProtocol({ ...options, runtimePath: equalsRuntime })).toThrow("equals signs");
    const percentRuntime = join(root, "bun %u");
    writeFileSync(percentRuntime, "fixture", { mode: 0o700 });
    expect(() => installClaudeDesktopProtocol({ ...options, runtimePath: percentRuntime })).toThrow("percent codes");
    chmodSync(options.runtimePath!, 0o600);
    expect(() => installClaudeDesktopProtocol(options)).toThrow("executable runtime");
    expect(existsSync(desktopPath)).toBe(false);
    expect(commands).toEqual([]);
  });

  test("bounds external registration failure and leaves repairable owned state without leaking output", () => {
    expect(() => installClaudeDesktopProtocol({ ...options, execCommand: () => { throw new Error("private output"); } }))
      .toThrow("XDG registration failed");
    expect(getClaudeDesktopProtocolStatus(options).status).toBe("installed");
    expect(installClaudeDesktopProtocol(options).status).toBe("unchanged");
  });

  test.each(["darwin", "win32"] as const)("refuses all operations on %s without touching files", platform => {
    const other = { ...options, platform };
    for (const operation of [installClaudeDesktopProtocol, getClaudeDesktopProtocolStatus, repairClaudeDesktopProtocol, uninstallClaudeDesktopProtocol]) {
      expect(() => operation(other)).toThrow("only on Linux");
    }
    expect(() => assertClaudeDesktopProtocolUri("ocx-desktop://sync", other)).toThrow("only on Linux");
    expect(existsSync(options.configDir!)).toBe(false);
    expect(commands).toEqual([]);
  });
});

linuxDescribe("Claude Desktop protocol ownership and repair", () => {
  test("never adopts a legacy/foreign desktop file without state, even if its marker matches", () => {
    file(desktopPath, "[Desktop Entry]\nX-OCX-Protocol-Version=1\nExec=old-handler %u\n");
    const original = readFileSync(desktopPath, "utf8");
    for (const operation of [installClaudeDesktopProtocol, getClaudeDesktopProtocolStatus, repairClaudeDesktopProtocol, uninstallClaudeDesktopProtocol]) {
      expect(() => operation(options)).toThrow("no ownership state");
    }
    expect(readFileSync(desktopPath, "utf8")).toBe(original);
    expect(existsSync(statePath)).toBe(false);
    expect(commands).toEqual([]);
  });

  test.each(["invalid JSON", '{"version":2}', "[]", "null"])("refuses invalid state %s", state => {
    file(statePath, state);
    for (const operation of [installClaudeDesktopProtocol, getClaudeDesktopProtocolStatus, repairClaudeDesktopProtocol, uninstallClaudeDesktopProtocol]) {
      expect(() => operation(options)).toThrow("ownership state is invalid");
    }
    expect(readFileSync(statePath, "utf8")).toBe(state);
    expect(existsSync(desktopPath)).toBe(false);
  });

  test("refuses tampered state fingerprints, paths, versions or additional fields", () => {
    installClaudeDesktopProtocol(options);
    const [desktop, originalState] = installedFiles();
    for (const patch of [{ fingerprint: "0".repeat(64) }, { desktopPath: join(root, "other.desktop") },
      { version: 2 }, { owner: "foreign" }, { extra: true }]) {
      writeFileSync(statePath, JSON.stringify({ ...JSON.parse(originalState), ...patch }));
      for (const operation of [installClaudeDesktopProtocol, repairClaudeDesktopProtocol, uninstallClaudeDesktopProtocol]) {
        expect(() => operation(options)).toThrow("ownership state is invalid");
      }
      expect(readFileSync(desktopPath, "utf8")).toBe(desktop);
    }
    expect(commands).toHaveLength(1);
  });

  test("refuses altered desktop bytes for status, install, repair and uninstall", () => {
    installClaudeDesktopProtocol(options);
    const [, state] = installedFiles();
    writeFileSync(desktopPath, "[Desktop Entry]\nExec=foreign %u\n");
    for (const operation of [installClaudeDesktopProtocol, getClaudeDesktopProtocolStatus, repairClaudeDesktopProtocol, uninstallClaudeDesktopProtocol]) {
      expect(() => operation(options)).toThrow("owned fingerprint");
    }
    expect(readFileSync(desktopPath, "utf8")).toContain("Exec=foreign");
    expect(readFileSync(statePath, "utf8")).toBe(state);
    expect(commands).toHaveLength(1);
  });

  test("package repair refreshes proven ownership after the old runtime/CLI have disappeared", () => {
    installClaudeDesktopProtocol(options);
    unlinkSync(options.runtimePath!);
    unlinkSync(options.cliPath!);
    const runtimePath = join(root, "new-bun");
    const cliPath = join(root, "new-cli.ts");
    writeFileSync(runtimePath, "new fixture", { mode: 0o700 });
    writeFileSync(cliPath, "new fixture");
    const next = { ...options, runtimePath, cliPath };
    expect(repairClaudeDesktopProtocol(next).status).toBe("repaired");
    expect(decodeExec(readFileSync(desktopPath, "utf8")).slice(0, 2)).toEqual([runtimePath, cliPath]);
    expect(JSON.parse(readFileSync(statePath, "utf8")).runtimePath).toBe(runtimePath);
    expect(repairClaudeDesktopProtocol(next).status).toBe("unchanged");
    expect(commands).toHaveLength(1);
  });

  test("only valid owned state permits restoring a missing desktop file", () => {
    installClaudeDesktopProtocol(options);
    unlinkSync(desktopPath);
    expect(getClaudeDesktopProtocolStatus(options).status).toBe("missing");
    expect(repairClaudeDesktopProtocol(options).status).toBe("repaired");
    expect(getClaudeDesktopProtocolStatus(options).status).toBe("installed");
    expect(commands).toHaveLength(1);
  });

  test.each(["desktop", "state"])("refuses %s file symlinks without changing their target", kind => {
    installClaudeDesktopProtocol(options);
    const target = kind === "desktop" ? desktopPath : statePath;
    const foreign = join(root, "foreign");
    writeFileSync(foreign, readFileSync(target));
    unlinkSync(target);
    symlinkSync(foreign, target);
    const before = readFileSync(foreign, "utf8");
    for (const operation of [installClaudeDesktopProtocol, getClaudeDesktopProtocolStatus, repairClaudeDesktopProtocol, uninstallClaudeDesktopProtocol]) {
      expect(() => operation(options)).toThrow("symbolic-link file");
    }
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readFileSync(foreign, "utf8")).toBe(before);
  });

  test("refuses dangling symlinks and symlinked parent directories", () => {
    mkdirSync(options.configDir!);
    symlinkSync(join(root, "missing"), statePath);
    expect(() => installClaudeDesktopProtocol(options)).toThrow("symbolic-link file");
    unlinkSync(statePath);
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, options.dataHome!);
    expect(() => installClaudeDesktopProtocol(options)).toThrow("ancestors");
    expect(existsSync(join(outside, "applications"))).toBe(false);
    expect(commands).toEqual([]);
  });

  test.each(["desktop", "state"])("bounds %s files and refuses non-regular paths", kind => {
    const target = kind === "desktop" ? desktopPath : statePath;
    file(target, "x".repeat(32 * 1024 + 1));
    expect(() => installClaudeDesktopProtocol(options)).toThrow("oversized");
    unlinkSync(target);
    mkdirSync(target);
    expect(() => uninstallClaudeDesktopProtocol(options)).toThrow("non-regular");
    expect(lstatSync(target).isDirectory()).toBe(true);
    expect(commands).toEqual([]);
  });

  test("uninstall removes only owned files, leaves other files and XDG settings intact, and is idempotent", () => {
    installClaudeDesktopProtocol(options);
    const mimeapps = join(options.dataHome!, "applications", "mimeapps.list");
    file(mimeapps, "[Default Applications]\nx-scheme-handler/other=foreign.desktop\n");
    const sibling = join(options.configDir!, "config.json");
    file(sibling, "{\"keep\":true}\n");
    expect(uninstallClaudeDesktopProtocol(options).status).toBe("uninstalled");
    expect(existsSync(desktopPath)).toBe(false);
    expect(existsSync(statePath)).toBe(false);
    expect(readFileSync(mimeapps, "utf8")).toContain("other=foreign.desktop");
    expect(readFileSync(sibling, "utf8")).toBe('{"keep":true}\n');
    expect(uninstallClaudeDesktopProtocol(options).status).toBe("absent");
    expect(repairClaudeDesktopProtocol(options).status).toBe("skipped");
    expect(commands).toHaveLength(1);
  });

  test("failed first-install state commit rolls back its new Desktop file before XDG registration", () => {
    const originalLink = fs.linkSync;
    const failure = spyOn(fs, "linkSync").mockImplementation((source, destination) => {
      if (String(destination) === statePath) throw new Error("fixture state commit failure");
      originalLink(source, destination);
    });
    try {
      expect(() => installClaudeDesktopProtocol(options)).toThrow("Desktop entry change was rolled back");
    } finally { failure.mockRestore(); }
    expect(existsSync(desktopPath)).toBe(false);
    expect(existsSync(statePath)).toBe(false);
    expect(getClaudeDesktopProtocolStatus(options).status).toBe("absent");
    expect(commands).toEqual([]);
    expect(installClaudeDesktopProtocol(options).status).toBe("installed");
  });

  test("failed update state commit atomically restores the previous owned Desktop fingerprint", () => {
    installClaudeDesktopProtocol(options);
    const before = installedFiles();
    const cliPath = join(root, "updated-cli.ts");
    writeFileSync(cliPath, "fixture updated CLI");
    const originalRename = fs.renameSync;
    const failure = spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (String(destination) === statePath) throw new Error("fixture state commit failure");
      originalRename(source, destination);
    });
    try {
      expect(() => repairClaudeDesktopProtocol({ ...options, cliPath })).toThrow("Desktop entry change was rolled back");
    } finally { failure.mockRestore(); }
    expect(installedFiles()).toEqual(before);
    expect(getClaudeDesktopProtocolStatus(options).status).toBe("installed");
    expect(commands).toHaveLength(1);
    expect(repairClaudeDesktopProtocol({ ...options, cliPath }).status).toBe("repaired");
  });

  test("reports rollback failure separately and preserves concurrent foreign Desktop changes", () => {
    const originalLink = fs.linkSync;
    const failure = spyOn(fs, "linkSync").mockImplementation((source, destination) => {
      if (String(destination) === statePath) {
        writeFileSync(desktopPath, "concurrent foreign Desktop entry");
        throw new Error("fixture state commit failure");
      }
      originalLink(source, destination);
    });
    try {
      expect(() => installClaudeDesktopProtocol(options)).toThrow("Desktop entry rollback failed");
    } finally { failure.mockRestore(); }
    expect(readFileSync(desktopPath, "utf8")).toBe("concurrent foreign Desktop entry");
    expect(existsSync(statePath)).toBe(false);
    expect(commands).toEqual([]);
  });

  test("rollback refuses an externally replaced file even if its bytes match this attempt", () => {
    const originalLink = fs.linkSync;
    const failure = spyOn(fs, "linkSync").mockImplementation((source, destination) => {
      if (String(destination) === statePath) {
        const replacement = join(root, "replacement.desktop");
        writeFileSync(replacement, readFileSync(desktopPath));
        fs.renameSync(replacement, desktopPath);
        throw new Error("fixture state commit failure");
      }
      originalLink(source, destination);
    });
    try {
      expect(() => installClaudeDesktopProtocol(options)).toThrow("Desktop entry rollback failed");
    } finally { failure.mockRestore(); }
    expect(existsSync(desktopPath)).toBe(true);
    expect(existsSync(statePath)).toBe(false);
    expect(commands).toEqual([]);
  });

  test("uninstall can remove owned state when its desktop file is already missing", () => {
    installClaudeDesktopProtocol(options);
    unlinkSync(desktopPath);
    expect(uninstallClaudeDesktopProtocol(options).status).toBe("uninstalled");
    expect(existsSync(statePath)).toBe(false);
  });
});

linuxDescribe("Claude Desktop protocol CLI dispatch", () => {
  const rejectedUris = ["", "OCX-DESKTOP://sync", "ocx-desktop://SYNC", "ocx-desktop://sync/",
    "ocx-desktop://sync?x=1", "ocx-desktop://sync#x", "ocx-desktop://user@sync", "ocx-desktop://sync:80",
    "ocx-desktop://%73ync", "ocx-desktop:sync", "ocx-desktop:///sync", " ocx-desktop://sync",
    "ocx-desktop://sync\n", "ocx-desktop://sync\0", "ocx-desktop://sync; touch /tmp/never",
    "https://sync", "ocx-desktop://restart", "ocx-desktop://sync/../restart"];

  test.each(rejectedUris)("rejects URI %j exactly before sync or any file/XDG action", async uri => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    let syncs = 0;
    try {
      expect(() => assertClaudeDesktopProtocolUri(uri, options)).toThrow("exact URI");
      expect(await handleClaudeDesktopCommand(["protocol", "dispatch", uri], {
        protocolOptions: options, syncLibrary: async () => { syncs++; return { status: "synced", models: 1 }; },
      })).toBe(1);
      expect(syncs).toBe(0);
      expect(commands).toEqual([]);
      expect(existsSync(options.configDir!)).toBe(false);
    } finally { error.mockRestore(); }
  });

  test("exact dispatch uses the same single sync implementation and never launches an exec command", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    let syncs = 0;
    const deps = { protocolOptions: options, syncLibrary: async () => {
      syncs++; return { status: "synced" as const, models: 3 };
    } };
    try {
      expect(await handleClaudeDesktopCommand(["protocol", "dispatch", "ocx-desktop://sync"], deps)).toBe(0);
      expect(await handleClaudeDesktopCommand(["sync"], deps)).toBe(0);
      expect(syncs).toBe(2);
      expect(log).toHaveBeenCalledWith("Claude Desktop: 3 models synced. Active sessions were not restarted.");
      expect(commands).toEqual([]);
      expect(existsSync(options.dataHome!)).toBe(false);
    } finally { log.mockRestore(); }
  });

  test("CLI install/status/uninstall use fixtures, never apply a profile or sync", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const deps = { protocolOptions: options, syncLibrary: async () => { throw new Error("sync must not run"); } };
    try {
      expect(await handleClaudeDesktopCommand(["protocol", "status"], deps)).toBe(0);
      expect(await handleClaudeDesktopCommand(["protocol", "install"], deps)).toBe(0);
      expect(await handleClaudeDesktopCommand(["protocol", "status"], deps)).toBe(0);
      expect(log).toHaveBeenCalledWith("Claude Desktop protocol: installed.");
      expect(await handleClaudeDesktopCommand(["protocol", "uninstall"], deps)).toBe(0);
      expect(commands).toHaveLength(1);
      expect(existsSync(statePath)).toBe(false);
    } finally { log.mockRestore(); }
  });

  test("internal __repair skips absent installation and repairs only fingerprint-owned fixtures", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    const deps = { protocolOptions: options };
    try {
      expect(await handleClaudeDesktopCommand(["protocol", "__repair"], deps)).toBe(0);
      expect(log).toHaveBeenCalledWith("Claude Desktop protocol: skipped.");
      expect(existsSync(options.configDir!)).toBe(false);
      installClaudeDesktopProtocol(options);
      unlinkSync(desktopPath);
      expect(await handleClaudeDesktopCommand(["protocol", "__repair"], deps)).toBe(0);
      expect(log).toHaveBeenCalledWith("Claude Desktop protocol: repaired.");
      writeFileSync(desktopPath, "foreign handler");
      expect(await handleClaudeDesktopCommand(["protocol", "__repair"], deps)).toBe(1);
      expect(readFileSync(desktopPath, "utf8")).toBe("foreign handler");
      expect(commands).toHaveLength(1);
    } finally { log.mockRestore(); error.mockRestore(); }
  });

  test.each([["protocol"], ["protocol", "repair"], ["protocol", "__repair", "extra"], ["protocol", "install", "extra"],
    ["protocol", "status", "--json"], ["protocol", "uninstall", "--static"],
    ["protocol", "dispatch"], ["protocol", "dispatch", "ocx-desktop://sync", "extra"],
    ["protocol", "dispatch", "ocx-desktop://sync", "--static"], ["sync", "extra"]])(
    "rejects malformed CLI argv %j without apply/sync/XDG", async (...args: string[]) => {
      const error = spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(await handleClaudeDesktopCommand(args, {
          protocolOptions: options, syncLibrary: async () => { throw new Error("sync must not run"); },
        })).toBe(1);
        expect(commands).toEqual([]);
        expect(existsSync(options.configDir!)).toBe(false);
      } finally { error.mockRestore(); }
    },
  );

  test("propagates sync failure through dispatch and refuses dispatch on other platforms", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    let syncs = 0;
    const syncLibrary = async (): Promise<never> => { syncs++; throw new Error("fixture sync failure"); };
    try {
      expect(await handleClaudeDesktopCommand(["protocol", "dispatch", "ocx-desktop://sync"], { protocolOptions: options, syncLibrary })).toBe(1);
      expect(syncs).toBe(1);
      expect(error).toHaveBeenCalledWith("fixture sync failure");
      expect(await handleClaudeDesktopCommand(["protocol", "dispatch", "ocx-desktop://sync"], {
        protocolOptions: { ...options, platform: "darwin" }, syncLibrary,
      })).toBe(1);
      expect(syncs).toBe(1);
    } finally { error.mockRestore(); }
  });
});

linuxDescribe("Claude Desktop protocol platform edge cases", () => {
  test("an empty or relative XDG_DATA_HOME falls back to ~/.local/share instead of failing", () => {
    const saved = { xdg: process.env.XDG_DATA_HOME, home: process.env.HOME };
    const { dataHome: _ignored, ...withoutDataHome } = options;
    try {
      process.env.HOME = root;
      for (const value of ["", "relative/share"]) {
        process.env.XDG_DATA_HOME = value;
        expect(getClaudeDesktopProtocolStatus(withoutDataHome).desktopPath)
          .toBe(join(homedir(), ".local", "share", "applications", "ocx-desktop.desktop"));
      }
      process.env.XDG_DATA_HOME = join(root, "custom-share") + "/";
      expect(getClaudeDesktopProtocolStatus(withoutDataHome).desktopPath)
        .toBe(join(root, "custom-share", "applications", "ocx-desktop.desktop"));
    } finally {
      if (saved.xdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = saved.xdg;
      if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
    }
  });

  test("install falls back to an exclusive create where hard links are unsupported", () => {
    const failure = spyOn(fs, "linkSync").mockImplementation(() => {
      throw Object.assign(new Error("hard links unsupported"), { code: "EPERM" });
    });
    try {
      expect(installClaudeDesktopProtocol(options).status).toBe("installed");
    } finally { failure.mockRestore(); }
    expect(fs.statSync(desktopPath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(join(desktopPath, ".."))).toEqual(["ocx-desktop.desktop"]);
    expect(getClaudeDesktopProtocolStatus(options).status).toBe("installed");
    expect(installClaudeDesktopProtocol(options).status).toBe("unchanged");
  });
});
