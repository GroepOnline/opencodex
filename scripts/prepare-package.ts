import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

try {
  const generate = Bun.spawnSync(["bun", "scripts/generate-build-info.ts"], { cwd: root, stdout: "ignore", stderr: "ignore" });
  if (generate.exitCode !== 0) {
    console.warn("prepare-package: generate-build-info skipped (non-fatal for local dev)");
  }
} catch {
  /* git-less npm consumers may not have bun on PATH during exotic installs */
}

function chmodIfExists(path: string, mode: number): void {
  if (!existsSync(path)) return;
  try { chmodSync(path, mode); } catch { /* best-effort for read-only filesystems */ }
}

function chmodTree(path: string): void {
  if (!existsSync(path)) return;
  const st = statSync(path);
  if (st.isDirectory()) {
    chmodIfExists(path, 0o755);
    for (const entry of readdirSync(path)) chmodTree(join(path, entry));
    return;
  }
  chmodIfExists(path, 0o644);
}

chmodIfExists(join(root, "bin", "ocx.mjs"), 0o755);
chmodIfExists(join(root, "bin", "package-main.mjs"), 0o644);
chmodTree(join(root, "gui", "dist"));
