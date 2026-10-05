import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import {
  activeDesktop3pAlias,
  atomicReplaceDesktopConfig,
  buildDesktop3pRegistry,
  deriveDesktop3pCode,
  desktop3pAlias,
  generateDesktop3pConfig,
  generateDesktop3pModels,
  legacyDesktop3pAlias,
  parseDesktop3pModeArgs,
  readAppliedDesktop3pLibrary,
  refreshDesktop3pRegistry,
  resetDesktop3pRegistryForTests,
  resolveDesktop3pConfigLibraryPath,
  resolveDesktop3pAlias,
} from "../src/claude/desktop-3p";
import { moveDesktopRoute, reconcileDesktopProfile, setDesktopFamilyDefault } from "../src/claude/desktop-profile";
import { resolveInboundModel } from "../src/claude/inbound";
import { getConfigPath, saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { clearRequestLogsForTests } from "../src/server/request-log";
import { managementFetch } from "./helpers/management-auth";
import { installIsolatedCodexHome } from "./helpers/isolated-codex-home";
import type { OcxClaudeDesktopProfile, OcxConfig } from "../src/types";

describe("Claude Desktop 3P models", () => {
  test("resolves the actual cross-platform Claude Desktop config library (#539)", () => {
    // Claude Desktop appends "-3p" to its userData root (app.asar `GE()`), so the
    // suffix-less path is one Desktop never reads. Branch-by-branch coverage lives in
    // tests/claude-desktop-config-path.test.ts; this pins the public entry point.
    expect(resolveDesktop3pConfigLibraryPath({
      env: { OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: " /custom/library " },
      platform: "darwin",
      homeDir: "/Users/test",
    })).toBe("/custom/library");
    // CLAUDE_USER_DATA_DIR is the one branch where Desktop drops the suffix entirely.
    expect(resolveDesktop3pConfigLibraryPath({
      env: { CLAUDE_USER_DATA_DIR: "/profiles/claude" },
      platform: "darwin",
      homeDir: "/Users/test",
    })).toBe(posix.join("/profiles/claude", "configLibrary"));
    expect(resolveDesktop3pConfigLibraryPath({
      env: {},
      platform: "darwin",
      homeDir: "/Users/test",
    })).toBe("/Users/test/Library/Application Support/Claude-3p/configLibrary");
    // Windows reads LOCALAPPDATA first; APPDATA is only the Electron userData fallback.
    // Asserted with `win32.join` because the separator follows the target platform, not the host.
    expect(resolveDesktop3pConfigLibraryPath({
      env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
      platform: "win32",
      homeDir: "C:\\Users\\test",
    })).toBe(win32.join("C:\\Users\\test\\AppData\\Local", "Claude-3p", "configLibrary"));
    expect(resolveDesktop3pConfigLibraryPath({
      env: { XDG_CONFIG_HOME: "/xdg/config" },
      platform: "linux",
      homeDir: "/home/test",
    })).toBe("/xdg/config/Claude-3p/configLibrary");
    expect(resolveDesktop3pConfigLibraryPath({
      env: {},
      platform: "linux",
      homeDir: "/home/test",
    })).toBe("/home/test/.config/Claude-3p/configLibrary");
  });

  test("derives stable golden codes", () => {
    expect(deriveDesktop3pCode("native/gpt-5.6-sol")).toBe("ncb");
    expect(deriveDesktop3pCode("opencode-go/glm-5.2")).toBe("yrf");
    expect(deriveDesktop3pCode("native/gpt-5.6-sol")).toMatch(/^[a-z][0-9a-z]{2}$/);
  });

  test("aliases use the opus-4-8 prefix and never collide with real dateless ids", () => {
    expect(desktop3pAlias("native", "gpt-5.6-sol")).toBe("claude-opus-4-8-ncb");
    expect(legacyDesktop3pAlias("native", "gpt-5.6-sol")).toBe("claude-opus-4-ncb");
    // Real Anthropic ids pass through untouched (dateless canonical form).
    expect(desktop3pAlias("anthropic", "claude-opus-4-8")).toBe("claude-opus-4-8");
    // Letter-first suffix: can never equal a bare real id or a numeric date suffix.
    expect(desktop3pAlias("native", "gpt-5.6-sol")).toMatch(/^claude-opus-4-8-[a-z][0-9a-z]{2}$/);
  });

  test("generates labeled opus-tier entries and one family default", () => {
    expect(generateDesktop3pModels(
      ["gpt-5.6-sol"],
      [{ provider: "opencode-go", id: "glm-5.2" }],
    )).toEqual([
      {
        name: "claude-opus-4-8-ncb",
        labelOverride: "GPT 5.6 Sol (native)",
        anthropicFamilyTier: "opus",
        isFamilyDefault: true,
      },
      {
        name: "claude-opus-4-8-yrf",
        labelOverride: "GLM 5.2 (opencode-go)",
        anthropicFamilyTier: "opus",
      },
    ]);
  });

  test("passes Anthropic Claude model ids through without encoding", () => {
    const models = generateDesktop3pModels([], [
      { provider: "anthropic", id: "claude-opus-4-6" },
    ]);
    expect(models[0]?.name).toBe("claude-opus-4-6");
    expect(models[0]?.anthropicFamilyTier).toBe("opus");
  });

  test("keeps real Anthropic ids OUT of the decode registry (native passthrough survives)", () => {
    buildDesktop3pRegistry([], [
      { provider: "anthropic", id: "claude-opus-4-8" },
      { provider: "anthropic", id: "claude-fable-5" },
    ]);
    expect(resolveDesktop3pAlias("claude-opus-4-8")).toBeNull();
    expect(resolveDesktop3pAlias("claude-fable-5")).toBeNull();
    // resolveInboundModel stays identity → wantsNativePassthrough keeps firing.
    expect(resolveInboundModel("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(resolveInboundModel("claude-fable-5")).toBe("claude-fable-5");
  });

  test("[1m] strip resolves registry-backed desktop aliases (audit R2#6)", () => {
    buildDesktop3pRegistry(["gpt-5.6-sol"], []);
    expect(resolveInboundModel("claude-opus-4-8-ncb[1m]")).toBe("gpt-5.6-sol");
  });

  test("resolves aliases from the current registry", () => {
    const registry = buildDesktop3pRegistry(
      ["gpt-5.6-sol"],
      [{ provider: "opencode-go", id: "glm-5.2" }],
    );
    expect(registry.get("claude-opus-4-8-ncb")).toBe("native/gpt-5.6-sol");
    expect(resolveDesktop3pAlias("claude-opus-4-8-yrf")).toBe("opencode-go/glm-5.2");
    // Legacy pre-rename aliases still decode (stale Desktop configs).
    expect(resolveDesktop3pAlias("claude-opus-4-ncb")).toBe("native/gpt-5.6-sol");
    expect(resolveDesktop3pAlias("claude-opus-4-yrf")).toBe("opencode-go/glm-5.2");
    expect(resolveDesktop3pAlias("claude-opus-4-8-unknown")).toBeNull();
  });

  test("warns and skips the second route on an alias collision", () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const models = generateDesktop3pModels([], [
        { provider: "test", id: "model-123" },
        { provider: "test", id: "model-155" },
      ]);
      expect(deriveDesktop3pCode("test/model-123")).toBe("vdu");
      expect(deriveDesktop3pCode("test/model-155")).toBe("vdu");
      expect(models).toHaveLength(1);
      expect(resolveDesktop3pAlias("claude-opus-4-8-vdu")).toBe("test/model-123");
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning.mock.calls.flat().join(" ")).toContain("skipping test/model-155");
    } finally {
      warning.mockRestore();
    }
  });

  test("generates a static config by default (list overrides discovery — no merge, devlog 138)", () => {
    const config = generateDesktop3pConfig(
      4096,
      ["gpt-5.6-sol"],
      [{ provider: "anthropic", id: "claude-opus-4-6" }, { provider: "cursor", id: "gpt-5.6-luna", contextWindow: 1_000_000 }],
      "test-key",
    );
    const reparsed = JSON.parse(JSON.stringify(config));
    expect(reparsed).toMatchObject({
      inferenceProvider: "gateway",
      inferenceCredentialKind: "static",
      inferenceGatewayBaseUrl: "http://127.0.0.1:4096",
      inferenceGatewayApiKey: "test-key",
      modelDiscoveryEnabled: false,
    });
    // Static list carries the pinned entries.
    expect(reparsed.inferenceModels.map((m: { name: string }) => m.name)).toEqual([
      "claude-opus-4-8-ncb",
      "claude-opus-4-6",
      desktop3pAlias("cursor", "gpt-5.6-luna"),
    ]);
    // supports1m ONLY where an authoritative contextWindow >= 1M was provided.
    const byName = new Map(reparsed.inferenceModels.map((m: { name: string }) => [m.name, m]));
    expect((byName.get(desktop3pAlias("cursor", "gpt-5.6-luna")) as { supports1m?: boolean }).supports1m).toBe(true);
    expect((byName.get("claude-opus-4-8-ncb") as { supports1m?: boolean }).supports1m).toBeUndefined();
    expect((byName.get("claude-opus-4-6") as { supports1m?: boolean }).supports1m).toBeUndefined();
    expect(resolveDesktop3pAlias("claude-opus-4-8-ncb")).toBe("native/gpt-5.6-sol");
  });

  test("hybrid mode keeps the static list AND discovery on (CCR-defensive)", () => {
    const config = generateDesktop3pConfig(4096, ["gpt-5.6-sol"], [], "test-key", "hybrid");
    const reparsed = JSON.parse(JSON.stringify(config));
    expect(reparsed.modelDiscoveryEnabled).toBe(true);
    expect(reparsed.inferenceModels.map((m: { name: string }) => m.name)).toEqual(["claude-opus-4-8-ncb"]);
  });

  test("generates a discovery-only config with --discovery-only", () => {
    const config = generateDesktop3pConfig(4096, ["gpt-5.6-sol"], [], "test-key", "discovery");
    const reparsed = JSON.parse(JSON.stringify(config));
    expect(reparsed.modelDiscoveryEnabled).toBe(true);
    expect(reparsed.inferenceModels).toBeUndefined();
    expect(resolveDesktop3pAlias("claude-opus-4-8-ncb")).toBe("native/gpt-5.6-sol");
  });

  test("parses desktop mode flags with mutual exclusion and unknown-flag rejection", () => {
    expect(parseDesktop3pModeArgs([])).toEqual({ mode: "static" });
    expect(parseDesktop3pModeArgs(["--static"])).toEqual({ mode: "static" });
    expect(parseDesktop3pModeArgs(["--hybrid"])).toEqual({ mode: "hybrid" });
    expect(parseDesktop3pModeArgs(["--discovery-only"])).toEqual({ mode: "discovery" });
    expect("error" in parseDesktop3pModeArgs(["--static", "--discovery-only"])).toBe(true);
    expect("error" in parseDesktop3pModeArgs(["--hybrid", "--static"])).toBe(true);
    expect(parseDesktop3pModeArgs(["--static", "--static"])).toEqual({ mode: "static" });
    expect("error" in parseDesktop3pModeArgs(["--wat"])).toBe(true);
  });

  test("generates a valid static gateway config with --static", () => {
    const config = generateDesktop3pConfig(
      4096,
      ["gpt-5.6-sol"],
      [{ provider: "anthropic", id: "claude-opus-4-6" }],
      "test-key",
      "static",
    );
    const reparsed = JSON.parse(JSON.stringify(config));
    expect(reparsed).toMatchObject({
      inferenceProvider: "gateway",
      inferenceCredentialKind: "static",
      inferenceGatewayBaseUrl: "http://127.0.0.1:4096",
      inferenceGatewayApiKey: "test-key",
      modelDiscoveryEnabled: false,
    });
    expect(reparsed.inferenceModels.map((model: { name: string }) => model.name)).toEqual([
      "claude-opus-4-8-ncb",
      "claude-opus-4-6",
    ]);
    // Static generation also refreshes the decode registry (new + legacy aliases).
    expect(resolveDesktop3pAlias("claude-opus-4-8-ncb")).toBe("native/gpt-5.6-sol");
    expect(resolveDesktop3pAlias("claude-opus-4-ncb")).toBe("native/gpt-5.6-sol");
  });

  test("renders persisted family/date assignments and installs their decode registry", () => {
    const routed = [{ provider: "cursor", id: "gpt-5.6-luna", contextWindow: 1_000_000 }];
    let profile = reconcileDesktopProfile(undefined, [
      { route: "native/gpt-5.6-sol", label: "GPT 5.6 Sol" },
      { route: "cursor/gpt-5.6-luna", label: "GPT 5.6 Luna", contextWindow: 1_000_000 },
    ]);
    profile = moveDesktopRoute(profile, "cursor/gpt-5.6-luna", "haiku", true);
    const models = generateDesktop3pModels(["gpt-5.6-sol"], routed, profile);
    const luna = models.find(model => model.labelOverride.includes("Luna"));
    expect(luna).toMatchObject({ anthropicFamilyTier: "haiku", isFamilyDefault: true, supports1m: true });
    expect(luna?.name).toMatch(/^claude-opus-4-8-2026\d{4}$/);
    expect(resolveDesktop3pAlias(luna!.name)).toBe("cursor/gpt-5.6-luna");
  });

  test("backs up owned config and preserves old bytes when atomic replacement fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-desktop-atomic-"));
    const path = join(dir, "owned.json");
    try {
      writeFileSync(path, "old bytes\n");
      const success = atomicReplaceDesktopConfig(path, "new bytes\n");
      expect(readFileSync(path, "utf8")).toBe("new bytes\n");
      expect(readFileSync(success.backupPath!, "utf8")).toBe("old bytes\n");

      writeFileSync(path, "stable bytes\n");
      expect(() => atomicReplaceDesktopConfig(path, "never written\n", () => { throw new Error("injected"); })).toThrow("injected");
      expect(readFileSync(path, "utf8")).toBe("stable bytes\n");
      expect(readFileSync(`${path}.bak`, "utf8")).toBe("stable bytes\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("legacy hash collisions stay bound to the same route when default ordering changes", () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const routed = [
        { provider: "test", id: "model-123" },
        { provider: "test", id: "model-155" },
      ];
      let profile = reconcileDesktopProfile(undefined, routed.map(model => ({
        route: `${model.provider}/${model.id}`,
        label: model.id,
      })));
      profile = setDesktopFamilyDefault(profile, "opus", "test/model-155");
      generateDesktop3pModels([], routed, profile);
      expect(legacyDesktop3pAlias("test", "model-123")).toBe(legacyDesktop3pAlias("test", "model-155"));
      expect(resolveDesktop3pAlias(legacyDesktop3pAlias("test", "model-123"))).toBe("test/model-123");
      expect(warning.mock.calls.flat().join(" ")).toContain("stays bound to test/model-123");
    } finally {
      warning.mockRestore();
    }
  });
});

describe("lazy applied Desktop registry", () => {
  const aliasA = "claude-opus-4-8-20260101";
  const aliasB = "claude-opus-4-8-20260102";
  const aliasUnused = "claude-opus-4-8-20260103";
  const nativeAlias = "claude-opus-4-6";

  function profile(route: string, alias: string): OcxClaudeDesktopProfile {
    return {
      version: 1,
      assignments: {
        [route]: { family: "opus", alias },
        "mock/unused": { family: "haiku", alias: aliasUnused },
        [`anthropic/${nativeAlias}`]: { family: "sonnet", alias: nativeAlias },
      },
      defaults: { opus: route, fable: null, sonnet: `anthropic/${nativeAlias}`, haiku: "mock/unused" },
    };
  }

  function externalReplace(path: string, value: unknown): void {
    // Independent writer: do not call any registry/config generator in this process.
    writeFileSync(`${path}.external`, JSON.stringify(value));
    renameSync(`${path}.external`, path);
  }

  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "ocx-desktop-registry-"));
    const oldHome = process.env.OPENCODEX_HOME;
    const oldLibrary = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
    const library = join(dir, "library");
    mkdirSync(library);
    process.env.OPENCODEX_HOME = dir;
    process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = library;
    const metaPath = join(library, "_meta.json");
    const activePath = join(library, "active.json");
    externalReplace(metaPath, { appliedId: "active", entries: [{ name: "opencodex", id: "active" }] });
    return {
      dir, library, metaPath, activePath,
      persist(stored: OcxClaudeDesktopProfile) {
        externalReplace(getConfigPath(), { claudeCode: { desktopProfile: stored } });
      },
      apply(alias: string, path = activePath) {
        externalReplace(path, { inferenceModels: [{ name: alias }, { name: nativeAlias }] });
      },
      restore() {
        resetDesktop3pRegistryForTests();
        if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
        else process.env.OPENCODEX_HOME = oldHome;
        if (oldLibrary === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
        else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = oldLibrary;
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  test("only active exact assignments publish, unchanged sources reuse the snapshot", () => {
    const f = fixture();
    try {
      f.persist(profile("mock/model-a", aliasA));
      f.apply(aliasA);
      expect(refreshDesktop3pRegistry()).toBe(true);
      expect(resolveInboundModel(aliasA)).toBe("mock/model-a");
      expect(activeDesktop3pAlias("mock", "model-a")).toBe(aliasA);
      expect(resolveDesktop3pAlias(aliasUnused)).toBeNull();
      expect(resolveDesktop3pAlias(nativeAlias)).toBeNull();
      expect(resolveDesktop3pAlias(legacyDesktop3pAlias("mock", "model-a"))).toBe("mock/model-a");
      expect(resolveInboundModel(legacyDesktop3pAlias("mock", "model-a"))).toBe("mock/model-a");
      expect(resolveDesktop3pAlias(legacyDesktop3pAlias("mock", "unused"))).toBeNull();
      expect(resolveDesktop3pAlias(legacyDesktop3pAlias("anthropic", nativeAlias))).toBeNull();
      const read = spyOn(fs, "readSync");
      try {
        expect(refreshDesktop3pRegistry()).toBe(false);
        expect(read).not.toHaveBeenCalled();
      } finally { read.mockRestore(); }
      const next = join(f.library, "next.json");
      f.persist(profile("mock/model-b", aliasB));
      f.apply(aliasB, next);
      // The old applied alias is now unknown: defer the incomplete writer transaction.
      expect(refreshDesktop3pRegistry()).toBe(false);
      expect(resolveInboundModel(aliasA)).toBe("mock/model-a");
      externalReplace(f.metaPath, { appliedId: "next", entries: [{ name: "opencodex", id: "next" }] });
      expect(refreshDesktop3pRegistry()).toBe(true);
      expect(resolveInboundModel(aliasB)).toBe("mock/model-b");
      expect(resolveDesktop3pAlias(aliasA)).toBeNull();
    } finally { f.restore(); }
  });

  test("lazy legacy hash collisions keep stable bindings across assignment and default order", () => {
    const f = fixture();
    try {
      const assignments: OcxClaudeDesktopProfile["assignments"] = {
        "test/model-155": { family: "opus", alias: aliasB },
        "test/model-123": { family: "opus", alias: aliasA },
      };
      const stored: OcxClaudeDesktopProfile = {
        version: 1, assignments,
        defaults: { opus: "test/model-155", fable: null, sonnet: null, haiku: null },
      };
      f.persist(stored);
      externalReplace(f.activePath, { inferenceModels: [{ name: aliasB }, { name: aliasA }] });
      expect(refreshDesktop3pRegistry()).toBe(true);
      const legacy = legacyDesktop3pAlias("test", "model-123");
      expect(legacy).toBe(legacyDesktop3pAlias("test", "model-155"));
      expect(resolveDesktop3pAlias(legacy)).toBe("test/model-123");
      expect(resolveDesktop3pAlias(aliasA)).toBe("test/model-123");
      expect(resolveDesktop3pAlias(aliasB)).toBe("test/model-155");
      f.persist({
        ...stored,
        assignments: Object.fromEntries(Object.entries(assignments).reverse()),
        defaults: { ...stored.defaults, opus: "test/model-123" },
      });
      externalReplace(f.activePath, { inferenceModels: [{ name: aliasA }, { name: aliasB }] });
      expect(refreshDesktop3pRegistry()).toBe(true);
      expect(resolveDesktop3pAlias(legacy)).toBe("test/model-123");
    } finally { f.restore(); }
  });

  test("discovery and generation cannot replace last-good applied state", () => {
    const f = fixture();
    try {
      const stale = profile("mock/model-a", aliasA);
      f.persist(stale);
      f.apply(aliasA);
      expect(refreshDesktop3pRegistry()).toBe(true);
      f.persist(profile("mock/model-b", aliasA));
      f.apply(aliasA);
      expect(refreshDesktop3pRegistry()).toBe(true);
      const assertApplied = () => {
        expect(resolveInboundModel(aliasA)).toBe("mock/model-b");
        expect(activeDesktop3pAlias("mock", "model-b")).toBe(aliasA);
        expect(resolveDesktop3pAlias(legacyDesktop3pAlias("mock", "model-b"))).toBe("mock/model-b");
      };
      const routed = [{ provider: "mock", id: "model-a" }];
      expect(buildDesktop3pRegistry([], routed, stale).get(aliasA)).toBe("mock/model-a");
      const discoveryAlias = activeDesktop3pAlias("mock", "model-a");
      expect(discoveryAlias).toBe(legacyDesktop3pAlias("mock", "model-a"));
      expect(resolveInboundModel(discoveryAlias)).toBe("mock/model-a");
      assertApplied();
      expect(refreshDesktop3pRegistry()).toBe(false);
      writeFileSync(getConfigPath(), "{");
      expect(refreshDesktop3pRegistry()).toBe(false);
      assertApplied();
      expect(generateDesktop3pModels([], routed, stale).some(model => model.name === aliasA)).toBe(true);
      assertApplied();
      generateDesktop3pConfig(10100, [], routed, "fixture", "discovery", stale);
      assertApplied();
      writeFileSync(f.activePath, "{");
      buildDesktop3pRegistry([], []);
      expect(refreshDesktop3pRegistry()).toBe(false);
      assertApplied();
      rmSync(f.metaPath);
      buildDesktop3pRegistry([], routed, stale);
      expect(refreshDesktop3pRegistry()).toBe(false);
      assertApplied();
      const discovery = profile("mock/model-c", aliasB);
      const discovered = buildDesktop3pRegistry([], [{ provider: "mock", id: "model-c" }], discovery);
      expect(discovered.get(aliasB)).toBe("mock/model-c");
      expect(activeDesktop3pAlias("mock", "model-c")).toBe(aliasB);
      expect(resolveInboundModel(aliasB)).toBe("mock/model-c");
      assertApplied();
    } finally { f.restore(); }
  });

  test("discovery never advertises an alias bound to another applied route", () => {
    const f = fixture();
    try {
      f.persist(profile("test/model-123", aliasA));
      f.apply(aliasA);
      expect(refreshDesktop3pRegistry()).toBe(true);
      buildDesktop3pRegistry([], [{ provider: "test", id: "model-155" }], profile("test/model-155", aliasA));
      expect(legacyDesktop3pAlias("test", "model-155")).toBe(legacyDesktop3pAlias("test", "model-123"));
      expect(() => activeDesktop3pAlias("test", "model-155")).toThrow("conflicts with the applied profile");
      expect(resolveInboundModel(aliasA)).toBe("test/model-123");
      expect(resolveDesktop3pAlias(legacyDesktop3pAlias("test", "model-123"))).toBe("test/model-123");
    } finally { f.restore(); }
  });

  test("malformed, oversized, inactive, and missing sources retain the whole last-good snapshot", () => {
    const f = fixture();
    try {
      f.persist(profile("mock/model-a", aliasA));
      f.apply(aliasA);
      expect(refreshDesktop3pRegistry()).toBe(true);
      const preserved = () => {
        expect(refreshDesktop3pRegistry()).toBe(false);
        expect(resolveInboundModel(aliasA)).toBe("mock/model-a");
        expect(activeDesktop3pAlias("mock", "model-a")).toBe(aliasA);
      };
      externalReplace(getConfigPath(), { claudeCode: { desktopProfile: { ...profile("mock/model-b", aliasB), version: 2 } } });
      preserved();
      f.persist(profile("mock/model-b", aliasB));
      writeFileSync(f.activePath, "{");
      preserved();
      writeFileSync(f.activePath, " ".repeat(1024 * 1024 + 1));
      preserved();
      f.apply(aliasB);
      externalReplace(f.metaPath, { appliedId: "../outside", entries: [{ name: "opencodex", id: "../outside" }] });
      preserved();
      externalReplace(f.metaPath, { appliedId: "other", entries: [{ name: "opencodex", id: "active" }] });
      preserved();
      rmSync(f.metaPath);
      preserved();
      externalReplace(f.metaPath, { appliedId: "active", entries: [{ name: "opencodex", id: "active" }] });
      expect(refreshDesktop3pRegistry()).toBe(true);
      expect(resolveInboundModel(aliasB)).toBe("mock/model-b");
    } finally { f.restore(); }
  });

  test("a file replacement during candidate reads never publishes a mixed registry", () => {
    const f = fixture();
    try {
      f.persist(profile("mock/model-a", aliasA));
      f.apply(aliasA);
      expect(refreshDesktop3pRegistry()).toBe(true);
      f.persist(profile("mock/model-b", aliasB));
      f.apply(aliasB);
      const originalRead = fs.readSync;
      let reads = 0;
      const read = spyOn(fs, "readSync").mockImplementation((
        fd: number, buffer: NodeJS.ArrayBufferView, offsetOrOptions?: number | fs.ReadOptions,
        length?: number, position?: fs.ReadPosition | null,
      ) => {
        const result = typeof offsetOrOptions === "number"
          ? originalRead(fd, buffer, offsetOrOptions, length!, position ?? null)
          : originalRead(fd, buffer, offsetOrOptions);
        if (++reads === 3) f.persist(profile("mock/model-c", aliasB));
        return result;
      });
      try {
        expect(refreshDesktop3pRegistry()).toBe(false);
        expect(reads).toBeGreaterThanOrEqual(3);
        expect(resolveInboundModel(aliasA)).toBe("mock/model-a");
        expect(activeDesktop3pAlias("mock", "model-a")).toBe(aliasA);
        expect(resolveDesktop3pAlias(aliasB)).toBeNull();
      } finally { read.mockRestore(); }
      expect(refreshDesktop3pRegistry()).toBe(true);
      expect(resolveInboundModel(aliasB)).toBe("mock/model-c");
    } finally { f.restore(); }
  });

  test("live messages and count_tokens observe independent atomic edits without discovery or restart", async () => {
    const f = fixture();
    const codex = installIsolatedCodexHome("ocx-desktop-registry-live-");
    clearRequestLogsForTests();
    const captured: string[] = [];
    const upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        expect(new URL(req.url).pathname).toBe("/v1/chat/completions");
        const body = await req.json() as { model: string };
        captured.push(body.model);
        return new Response([
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""), { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    let server: ReturnType<typeof startServer> | undefined;
    try {
      const config: OcxConfig = {
        port: 0,
        defaultProvider: "mock",
        providers: { mock: {
          adapter: "openai-chat", baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`,
          apiKey: "fixture", allowPrivateNetwork: true, liveModels: false,
        } },
        claudeCode: { desktopProfile: profile("mock/model-a", aliasA) },
      };
      saveConfig(config);
      f.apply(aliasA);
      buildDesktop3pRegistry([], []);
      server = startServer(0);
      const post = (path: string, alias: string) => managementFetch(new URL(path, server!.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: alias, max_tokens: 32, messages: [{ role: "user", content: "hi" }] }),
      });
      const turn = async (alias: string) => {
        const res = await post("/v1/messages", alias);
        expect(res.status).toBe(200);
        expect((await res.json() as { content: unknown }).content).toBeDefined();
      };
      await turn(aliasA);
      expect(captured).toEqual(["model-a"]);
      // Preserve routing config while changing only persisted Desktop state, outside the live server.
      externalReplace(getConfigPath(), { ...config, claudeCode: { desktopProfile: profile("mock/model-b", aliasB) } });
      f.apply(aliasB);
      const counted = await post("/v1/messages/count_tokens", aliasB);
      expect(counted.status).toBe(200);
      expect((await counted.json() as { input_tokens: number }).input_tokens).toBeGreaterThan(0);
      expect(resolveInboundModel(aliasB)).toBe("mock/model-b");
      await turn(aliasB);
      externalReplace(getConfigPath(), { ...config, claudeCode: { desktopProfile: profile("mock/model-c", aliasA) } });
      f.apply(aliasA);
      await turn(aliasA);
      expect(captured).toEqual(["model-a", "model-b", "model-c"]);
      writeFileSync(getConfigPath(), "{");
      f.apply(aliasB);
      await turn(aliasA);
      externalReplace(getConfigPath(), { ...config, claudeCode: { desktopProfile: profile("mock/model-c", aliasA) } });
      writeFileSync(f.activePath, "{");
      await turn(aliasA);
      expect(captured).toEqual(["model-a", "model-b", "model-c", "model-c", "model-c"]);
    } finally {
      await server?.stop(true);
      await upstream.stop(true);
      clearRequestLogsForTests();
      codex.restore();
      f.restore();
    }
  });
});

describe("readAppliedDesktop3pLibrary", () => {
  function libraryOptions(dir: string) {
    return {
      env: { OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: dir },
      platform: "linux" as const,
      homeDir: dir,
    };
  }

  test("returns 404 when the library has not been applied", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-3p-lib-empty-"));
    try {
      expect(readAppliedDesktop3pLibrary(libraryOptions(dir))).toEqual({
        ok: false,
        status: 404,
        error: "Claude Desktop 3P library not applied yet",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns 404 when _meta.json has no appliedId", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-3p-lib-meta-"));
    try {
      writeFileSync(join(dir, "_meta.json"), JSON.stringify({ entries: [] }));
      expect(readAppliedDesktop3pLibrary(libraryOptions(dir))).toEqual({
        ok: false,
        status: 404,
        error: "Claude Desktop 3P library has no appliedId",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns 404 when _meta.json is not a JSON object", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-3p-lib-meta-shape-"));
    try {
      writeFileSync(join(dir, "_meta.json"), "[]");
      expect(readAppliedDesktop3pLibrary(libraryOptions(dir))).toEqual({
        ok: false,
        status: 404,
        error: "Claude Desktop 3P library has no appliedId",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns 404 when the applied config file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-3p-lib-missing-"));
    try {
      writeFileSync(join(dir, "_meta.json"), JSON.stringify({
        appliedId: "opencodex",
        entries: [{ id: "opencodex", name: "opencodex" }],
      }));
      expect(readAppliedDesktop3pLibrary(libraryOptions(dir))).toEqual({
        ok: false,
        status: 404,
        error: "Claude Desktop 3P config missing",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns 404 when appliedId does not match the opencodex registry entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-3p-lib-mismatch-"));
    try {
      writeFileSync(join(dir, "_meta.json"), JSON.stringify({
        appliedId: "other-id",
        entries: [{ id: "opencodex", name: "opencodex" }],
      }));
      expect(readAppliedDesktop3pLibrary(libraryOptions(dir))).toEqual({
        ok: false,
        status: 404,
        error: "Claude Desktop 3P config missing",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects appliedId values that could escape the library directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-3p-lib-escape-"));
    try {
      writeFileSync(join(dir, "_meta.json"), JSON.stringify({
        appliedId: "../secrets",
        entries: [{ id: "../secrets", name: "opencodex" }],
      }));
      expect(readAppliedDesktop3pLibrary(libraryOptions(dir))).toEqual({
        ok: false,
        status: 404,
        error: "Claude Desktop 3P library has no appliedId",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns ok payload and keeps 404 errors free of the gateway key", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-3p-lib-ok-"));
    const secret = "INFERENCE_GATEWAY_API_KEY_FIXTURE";
    try {
      writeFileSync(join(dir, "_meta.json"), JSON.stringify({
        appliedId: "opencodex",
        entries: [{ id: "opencodex", name: "opencodex" }],
      }));
      writeFileSync(join(dir, "opencodex.json"), JSON.stringify({
        inferenceProvider: "gateway",
        inferenceGatewayApiKey: secret,
      }));
      const result = readAppliedDesktop3pLibrary(libraryOptions(dir));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.appliedId).toBe("opencodex");
      expect(result.config).toEqual({
        inferenceProvider: "gateway",
        inferenceGatewayApiKey: secret,
      });
      expect(result.fingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(result.laptopGateway).toBe("http://127.0.0.1:10100");
      const missing = readAppliedDesktop3pLibrary(libraryOptions(join(dir, "absent")));
      expect(missing.ok).toBe(false);
      expect(JSON.stringify(missing)).not.toContain(secret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
