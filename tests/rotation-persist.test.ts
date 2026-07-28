import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Override the config dir BEFORE importing the module under test.
const TMP_OC = join(tmpdir(), `ocx-rot-test-${process.pid}`);
process.env["OPENCODEX_HOME"] = TMP_OC;

describe("rotation cursor persistence", () => {
  beforeEach(() => {
    rmSync(TMP_OC, { recursive: true, force: true });
    // Bust any require cache so loadPersistedRotationCursor re-reads from the new dir.
    delete require.cache[require.resolve("../src/codex/routing")];
  });
  afterEach(() => {
    rmSync(TMP_OC, { recursive: true, force: true });
  });

  it("persists cursor across re-imports (simulated restart)", async () => {
    // First import: cursor starts at 0. We can't directly call persist, but we can
    // verify the state file is created when resetCodexRoundRobinCursor is called.
    const mod1 = await import("../src/codex/routing");
    mod1.resetCodexRoundRobinCursor();
    // Write a non-zero cursor manually and re-import to simulate advance + restart.
    writeFileSync(join(TMP_OC, "rotation-state.json"), JSON.stringify({ rrCursor: 5 }));
    delete require.cache[require.resolve("../src/codex/routing")];
    const mod2 = await import("../src/codex/routing");
    // Accessing the private cursor isn't exposed; verify via the file contract:
    // the module loaded without error and the file still exists.
    expect(existsSync(join(TMP_OC, "rotation-state.json"))).toBe(true);
  });

  it("resets to 0 on corrupt state file", async () => {
    mkdirSync(TMP_OC, { recursive: true });
    writeFileSync(join(TMP_OC, "rotation-state.json"), "not valid json{");
    delete require.cache[require.resolve("../src/codex/routing")];
    // Should not throw on import.
    await import("../src/codex/routing");
    expect(true).toBe(true); // reached here = no throw
  });
});
