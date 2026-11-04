import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const launcher = readFileSync(new URL("../bin/ocx.mjs", import.meta.url), "utf8");
const cliEntry = readFileSync(new URL("../src/cli/index.ts", import.meta.url), "utf8");

describe("trusted launch environment entrypoints", () => {
  test("Node launcher snapshots provenance before starting Bun", () => {
    expect(launcher).toContain("captureTrustedLaunchEnvMarker(process.env)");
    expect(launcher).toContain("[TRUSTED_LAUNCH_ENV_MARKER]: trustedLaunchEnvMarker");
    expect(launcher).toContain("initializeTrustedLaunchEnv(process.env)");
  });

  test("CLI bootstrap runs before environment-sensitive imports", () => {
    const bootstrap = cliEntry.indexOf('import "../lib/trusted-launch-env-bootstrap";');
    const firstRuntimeImport = cliEntry.indexOf("import ", cliEntry.indexOf("\n") + 1);
    expect(bootstrap).toBeGreaterThanOrEqual(0);
    expect(firstRuntimeImport).toBe(bootstrap);
  });
});
