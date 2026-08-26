import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

describe("container smoke script", () => {
  test("pins docker build identity, file-backed token, and /healthz", async () => {
    const script = await Bun.file(join(repoRoot, "scripts/container-smoke.sh")).text();
    expect(script).toContain("docker build");
    expect(script).toContain("OPENCODEX_API_AUTH_TOKEN_FILE");
    expect(script).toContain("VCS_REF");
    expect(script).toContain("/healthz");
    expect(script).toContain('body.get("service") == "opencodex"');
    expect(script).not.toMatch(/OPENCODEX_API_AUTH_TOKEN=/);
  });
});
