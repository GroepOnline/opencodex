import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const launcher = readFileSync(join(root, "bin", "ocx.mjs"), "utf8");
const bunUpdater = readFileSync(join(root, "src", "update", "index.ts"), "utf8");

describe("update does not tell external tunnel clients to start a competing proxy", () => {
  test("npm global updater distinguishes an owned foreground proxy from a tunnel", () => {
    expect(launcher).not.toContain("Restart the proxy:  ocx start");
    expect(launcher).toContain("If this machine owns the local proxy");
    expect(launcher).toContain("externally managed gateway or tunnel");
  });
  test("Bun global updater uses the same conditional guidance", () => {
    expect(bunUpdater).not.toContain("Restart the proxy:  ocx start");
    expect(bunUpdater).toContain("If this machine owns the local proxy");
    expect(bunUpdater).toContain("externally managed gateway or tunnel");
  });
});
