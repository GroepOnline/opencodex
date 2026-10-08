import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

function isPathInside(path: string, root: string): boolean {
  const resolved = resolve(path);
  const resolvedRoot = resolve(root);
  return (
    resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${sep}`)
  );
}

/**
 * Refuse usage.jsonl writes that would land in the operator's live home.
 *
 * Tests historically called `appendUsageEntry` with `OPENCODEX_HOME` unset, so
 * `getConfigDir()` resolved to `~/.opencodex` and fixtures polluted production.
 * Active only when a test preload (or `BUN_TEST`) marked the process.
 */
export function assertUsageLogPathIsolatedForTests(path: string): void {
  const inTests =
    Boolean(process.env.OPENCODEX_TEST_HOME?.trim()) ||
    process.env.BUN_TEST === "1";
  if (!inTests) return;

  const realHome = process.env.OPENCODEX_REAL_HOME?.trim();
  if (realHome) {
    const liveDir = resolve(join(realHome, ".opencodex"));
    if (isPathInside(path, liveDir)) {
      throw new Error(
        "usage.jsonl write escaped test isolation: refused the live OPENCODEX home",
      );
    }
  }

  if (!isPathInside(path, tmpdir())) {
    throw new Error(
      "usage.jsonl write escaped test isolation: destination is not under the system temp directory",
    );
  }
}
