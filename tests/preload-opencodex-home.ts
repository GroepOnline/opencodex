/**
 * Process-wide usage-home isolation for every `bun test` invocation.
 *
 * `scripts/test.ts` already redirects OPENCODEX_HOME for `bun run test`, but a
 * bare `bun test` (or a single-file filter) skips that wrapper. getConfigDir()
 * then falls back to `join(homedir(), ".opencodex")` and appendUsageEntry writes
 * fixtures into the live usage.jsonl. Capture the real home first so the
 * append-path guard can refuse that directory without deleting it.
 */
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const realHome = process.env.OPENCODEX_REAL_HOME?.trim()
  || process.env.HOME?.trim()
  || process.env.USERPROFILE?.trim()
  || homedir();
process.env.OPENCODEX_REAL_HOME = realHome;

const isolatedHome = mkdtempSync(join(tmpdir(), "ocx-test-opencodex-home-"));
process.env.OPENCODEX_HOME = isolatedHome;
process.env.OPENCODEX_TEST_HOME = isolatedHome;
