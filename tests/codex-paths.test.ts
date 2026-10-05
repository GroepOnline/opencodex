import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCodexHome } from "../src/codex/paths";

const previous = process.env.CODEX_HOME;
const dirs: string[] = [];
afterEach(() => {
  if (previous === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previous;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ocx-codex-paths-"));
  dirs.push(dir);
  return dir;
}

test("runtime Codex home validates and canonicalizes an explicit directory", () => {
  const dir = fixture();
  const nested = join(dir, "codex");
  mkdirSync(nested);
  process.env.CODEX_HOME = ` ${nested} `;
  expect(getCodexHome()).toBe(realpathSync.native(nested));
});

test("runtime Codex home never falls back from an invalid explicit path", () => {
  const dir = fixture();
  process.env.CODEX_HOME = join(dir, "missing");
  expect(() => getCodexHome()).toThrow("could not be read");
  process.env.CODEX_HOME = join(dir, "file");
  writeFileSync(process.env.CODEX_HOME, "not a directory\n");
  expect(() => getCodexHome()).toThrow("not a directory");
});
