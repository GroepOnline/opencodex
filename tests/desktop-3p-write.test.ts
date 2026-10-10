import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicReplaceDesktopConfig,
  DESKTOP_LIBRARY_ID,
  DESKTOP_SUPPORTS_1M_THRESHOLD,
  writeDesktop3pConfig,
} from "../src/claude/desktop-3p";
import { DESKTOP_SUPPORTS_1M_THRESHOLD as PROFILE_1M_THRESHOLD } from "../src/claude/desktop-profile";

let dir: string;
const saved = {
  library: process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR,
  home: process.env.OPENCODEX_HOME,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocx-desktop-write-"));
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(dir, "library");
  process.env.OPENCODEX_HOME = join(dir, "home");
  fs.mkdirSync(join(dir, "library"), { recursive: true });
});

afterEach(() => {
  if (saved.library === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = saved.library;
  if (saved.home === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = saved.home;
  rmSync(dir, { recursive: true, force: true });
});

const library = () => join(dir, "library");
const write = (port = 10100) => writeDesktop3pConfig(port, ["gpt-5.6-sol"], [], "test-key", "static");

test("a stale .bak is never reported as this call's backup", () => {
  const path = join(library(), "fresh.json");
  writeFileSync(`${path}.bak`, "stale\n");
  const result = atomicReplaceDesktopConfig(path, "fresh\n");
  expect(result).toEqual({ created: true });
  expect(readFileSync(`${path}.bak`, "utf8")).toBe("stale\n");
  expect(readFileSync(path, "utf8")).toBe("fresh\n");
});

test("metadata failure removes a config this call created instead of restoring a stale .bak", () => {
  const meta = JSON.stringify({ entries: [{ id: "existing-id", name: "opencodex" }], appliedId: "existing-id" });
  writeFileSync(join(library(), "_meta.json"), meta);
  writeFileSync(join(library(), "existing-id.json.bak"), "stale\n");
  const originalRename = fs.renameSync;
  const failure = spyOn(fs, "renameSync").mockImplementation((source, destination) => {
    if (String(destination).endsWith("_meta.json")) throw new Error("fixture metadata failure");
    originalRename(source, destination);
  });
  try {
    expect(write().written).toBe(false);
  } finally { failure.mockRestore(); }
  expect(existsSync(join(library(), "existing-id.json"))).toBe(false);
  expect(readFileSync(join(library(), "existing-id.json.bak"), "utf8")).toBe("stale\n");
  expect(readFileSync(join(library(), "_meta.json"), "utf8")).toBe(meta);
});

test("an opencodex entry with an unsafe id is refused before any write", () => {
  for (const id of ["../escape", "_meta", "a/b", ""]) {
    const meta = JSON.stringify({ entries: [{ id, name: "opencodex" }], appliedId: id });
    writeFileSync(join(library(), "_meta.json"), meta);
    const result = write();
    expect(result.written).toBe(false);
    expect(result.reason).toContain("unsafe id");
    expect(readFileSync(join(library(), "_meta.json"), "utf8")).toBe(meta);
    expect(existsSync(join(dir, "escape.json"))).toBe(false);
  }
});

test("an invalid gateway port is refused", () => {
  for (const port of [0, -1, 65536, 1.5, Number.NaN]) expect(write(port).written).toBe(false);
  expect(write(10100).written).toBe(true);
});

test("library ids can never alias _meta or escape the library", () => {
  expect(DESKTOP_LIBRARY_ID.test("0f8fad5b-d9cb-469f-a165-70867728950e")).toBe(true);
  expect(DESKTOP_LIBRARY_ID.test("old")).toBe(true);
  for (const id of ["_meta", "../x", "a/b", "", "x".repeat(129)]) expect(DESKTOP_LIBRARY_ID.test(id)).toBe(false);
});

test("the 1M threshold has one source of truth", () => {
  expect(DESKTOP_SUPPORTS_1M_THRESHOLD).toBe(PROFILE_1M_THRESHOLD);
  expect(DESKTOP_SUPPORTS_1M_THRESHOLD).toBe(1_000_000);
});
