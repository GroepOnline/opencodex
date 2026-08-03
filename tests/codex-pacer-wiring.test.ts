import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the main→dev reconcile fix: pacer existed on main but lost its
 * responses.ts call site after the responses split. Keep both send paths wired.
 */
describe("codex pacer wiring", () => {
  test("responses core and compact await codexPaceBeforeSend for pool auth", () => {
    const root = join(import.meta.dir, "..");
    const core = readFileSync(join(root, "src/server/responses/core.ts"), "utf8");
    const compact = readFileSync(join(root, "src/server/responses/compact.ts"), "utf8");
    expect(core).toContain('from "../../codex/pacer"');
    expect(compact).toContain('from "../../codex/pacer"');
    expect(core).toContain("codexPaceBeforeSend(config, authCtx.accountId, configuredCodexPoolSize(config), upstream.signal)");
    expect(compact).toContain("codexPaceBeforeSend(config, authCtx.accountId, configuredCodexPoolSize(config), req.signal)");
    expect(core).toContain("usesCodexForwardPoolAuth(authCtx, route.provider)");
    expect(compact).toContain("usesCodexForwardPoolAuth(authCtx, route.provider)");
  });
});
