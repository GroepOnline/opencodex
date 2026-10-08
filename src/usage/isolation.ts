import { basename, dirname, join, resolve, sep } from "node:path";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";

function filesystemPath(path: string, hops = 0): string {
  if (hops > 40)
    throw new Error("usage.jsonl test isolation: too many symlinks");
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    try {
      if (lstatSync(absolute).isSymbolicLink()) {
        return filesystemPath(
          resolve(dirname(absolute), readlinkSync(absolute)),
          hops + 1,
        );
      }
    } catch (linkError) {
      const code = (linkError as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw linkError;
    }
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(filesystemPath(parent, hops), basename(absolute));
  }
}

function isPathInside(path: string, root: string): boolean {
  const resolved = filesystemPath(path);
  const resolvedRoot = filesystemPath(root);
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

  const original = process.env.OPENCODEX_REAL_CONFIG_DIR?.trim();
  if (original && isPathInside(path, original)) {
    throw new Error(
      "usage.jsonl write escaped test isolation: refused the original configured OPENCODEX home",
    );
  }
  if (!isPathInside(path, tmpdir())) {
    throw new Error(
      "usage.jsonl write escaped test isolation: destination is not under the system temp directory",
    );
  }
}
