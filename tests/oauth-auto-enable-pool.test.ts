import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoEnableOAuthAccountPoolOnSecondAccount } from "../src/oauth/auto-enable-pool";
import { saveCredential } from "../src/oauth/store";
import type { OcxConfig } from "../src/types";

const previousOpencodexHome = process.env.OPENCODEX_HOME;
let opencodexHome: string;

function emptyConfig(): OcxConfig {
  return {
    port: 10100,
    providers: {},
    defaultProvider: "openai",
  };
}

beforeEach(() => {
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-auto-pool-"));
  process.env.OPENCODEX_HOME = opencodexHome;
});

afterEach(() => {
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  rmSync(opencodexHome, { recursive: true, force: true });
});

describe("autoEnableOAuthAccountPoolOnSecondAccount", () => {
  test("turns Cursor pool on only for the 1→2 crossing", async () => {
    const config = emptyConfig();
    const expires = Date.now() + 60 * 60_000;
    await saveCredential("cursor", {
      access: "a1", refresh: "r1", expires, accountId: "cursor-a", email: "a@cursor.test",
    });
    expect(autoEnableOAuthAccountPoolOnSecondAccount(config, "cursor", 0)).toBe(false);
    expect(config.cursorAccountPool).toBeUndefined();

    await saveCredential("cursor", {
      access: "b1", refresh: "r2", expires, accountId: "cursor-b", email: "b@cursor.test",
    });
    expect(autoEnableOAuthAccountPoolOnSecondAccount(config, "cursor", 1)).toBe(true);
    expect(config.cursorAccountPool?.enabled).toBe(true);

    expect(autoEnableOAuthAccountPoolOnSecondAccount(config, "cursor", 2)).toBe(false);
  });

  test("does not re-enable a pool the operator already turned off", async () => {
    const config: OcxConfig = {
      ...emptyConfig(),
      cursorAccountPool: { enabled: false },
    };
    const expires = Date.now() + 60 * 60_000;
    await saveCredential("cursor", {
      access: "a1", refresh: "r1", expires, accountId: "cursor-a", email: "a@cursor.test",
    });
    await saveCredential("cursor", {
      access: "b1", refresh: "r2", expires, accountId: "cursor-b", email: "b@cursor.test",
    });
    // Two accounts already exist; this write is a duplicate identity, not 1→2.
    expect(autoEnableOAuthAccountPoolOnSecondAccount(config, "cursor", 2)).toBe(false);
    expect(config.cursorAccountPool?.enabled).toBe(false);
  });

  test("ignores providers without an OAuth account pool", async () => {
    const config = emptyConfig();
    expect(autoEnableOAuthAccountPoolOnSecondAccount(config, "kiro", 1)).toBe(false);
  });
});
