import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const configUrl = new URL("../vite.config.ts", import.meta.url);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const imageSha = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
const checkoutSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
})
  .trim()
  .toLowerCase();

// A fresh process prevents Vite's import cache and process.env from leaking between cases.
function readBuildIdentity(suppliedSha: string, gitAvailable: boolean) {
  const emptyPath = mkdtempSync(join(tmpdir(), "ocx-gui-identity-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--eval",
        `
      const { default: config } = await import(${JSON.stringify(configUrl.href)});
      console.log(config.define.__APP_GIT_SHA__);
    `,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          OPENCODEX_GIT_SHA: suppliedSha,
          PATH: gitAvailable ? process.env.PATH : emptyPath,
        },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout.trim()) as string | null;
  } finally {
    rmSync(emptyPath, { recursive: true, force: true });
  }
}

test.each([true, false])(
  "a trusted image SHA is normalized and takes precedence (git=%s)",
  (gitAvailable) => {
    expect(readBuildIdentity(imageSha, gitAvailable)).toBe(
      imageSha.toLowerCase(),
    );
  },
);

test.each([
  "",
  "unknown",
  imageSha.slice(0, 39),
  `${imageSha}0`,
  "g".repeat(40),
  ` ${imageSha}`,
  `${imageSha}\n`,
])(
  "invalid image SHA %j falls back to the checkout, or null in an archive",
  (suppliedSha) => {
    expect(readBuildIdentity(suppliedSha, true)).toBe(checkoutSha);
    expect(readBuildIdentity(suppliedSha, false)).toBeNull();
  },
);
