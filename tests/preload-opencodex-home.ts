/** Isolate bare and filtered Bun test runs without sharing a live usage home. */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const realHome =
  process.env.OPENCODEX_REAL_HOME?.trim() ||
  process.env.HOME?.trim() ||
  process.env.USERPROFILE?.trim() ||
  homedir();
process.env.OPENCODEX_REAL_HOME = realHome;

// Bun's isolated module caches execute preloads again for each test file.
// Reuse only this process's temporary home; a child process owns a fresh one.
const previous = process.env.OPENCODEX_TEST_HOME?.trim();
const reusable =
  process.env.OPENCODEX_TEST_OWNER_PID === String(process.pid) &&
  previous &&
  resolve(previous).startsWith(resolve(tmpdir()) + sep) &&
  existsSync(previous);
const isolatedHome = reusable
  ? previous!
  : mkdtempSync(join(tmpdir(), "ocx-test-opencodex-home-"));
if (!reusable) {
  process.env.OPENCODEX_TEST_OWNER_PID = String(process.pid);
  process.once("exit", () => {
    try {
      rmSync(isolatedHome, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });
}
process.env.OPENCODEX_HOME = isolatedHome;
process.env.OPENCODEX_TEST_HOME = isolatedHome;
