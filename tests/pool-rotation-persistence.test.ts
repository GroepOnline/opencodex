import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  clearPoolRotationState,
  installPoolRotationPersistence,
  peekRoundRobinAccount,
  pickRoundRobinAccount,
  POOL_ROTATION_STATE_FILENAME,
  seedPoolRotationAccount,
  uninstallPoolRotationPersistence,
} from "../src/codex/pool-rotation";

const ROOT = join(import.meta.dir, `.tmp-pool-rotation-persistence-${process.pid}`);
let previousOpencodexHome: string | undefined;
let statePath: string;

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  previousOpencodexHome = process.env["OPENCODEX_HOME"];
  statePath = join(ROOT, POOL_ROTATION_STATE_FILENAME);
});

afterEach(() => {
  clearPoolRotationState();
  uninstallPoolRotationPersistence();
  rmSync(ROOT, { recursive: true, force: true });
  if (previousOpencodexHome === undefined) delete process.env["OPENCODEX_HOME"];
  else process.env["OPENCODEX_HOME"] = previousOpencodexHome;
});

test("no disk state without an install", () => {
  pickRoundRobinAccount("codex", ["a", "b"], 1);
  expect(existsSync(statePath)).toBe(false);
});

test("a selection mutates and writes version 1 state", () => {
  installPoolRotationPersistence(statePath);
  pickRoundRobinAccount("codex", ["a", "b"], 1);
  expect(existsSync(statePath)).toBe(true);
  const parsed = JSON.parse(readFileSync(statePath, "utf8"));
  expect(parsed.version).toBe(1);
  expect(parsed.pools["codex"]).toBeDefined();
});

test("a seeded account survives install/uninstall round-trip", () => {
  installPoolRotationPersistence(statePath);
  seedPoolRotationAccount("codex", "seeded");
  uninstallPoolRotationPersistence();

  installPoolRotationPersistence(statePath);
  expect(peekRoundRobinAccount("codex", ["seeded", "other"], 1)).toBe("seeded");
});

test("clearing removes the persisted snapshot", () => {
  installPoolRotationPersistence(statePath);
  seedPoolRotationAccount("codex", "seeded");
  expect(existsSync(statePath)).toBe(true);
  clearPoolRotationState();
  expect(existsSync(statePath)).toBe(false);
});

test("a corrupt state file is ignored, not fatal", () => {
  writeFileSync(statePath, "{not json", { mode: 0o600 });
  installPoolRotationPersistence(statePath);
  expect(existsSync(statePath)).toBe(true);
  const picked = pickRoundRobinAccount("codex", ["a", "b"], 1);
  expect(picked).not.toBeNull();
});
