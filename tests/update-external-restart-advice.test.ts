import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { foregroundRestartAdvice } from "../src/update/restart-advice.mjs";

const root = join(import.meta.dir, "..");
const launcher = readFileSync(join(root, "bin", "ocx.mjs"), "utf8");
const bunUpdater = readFileSync(
  join(root, "src", "update", "index.ts"),
  "utf8",
);

describe("update does not tell external tunnel clients to start a competing proxy", () => {
  test("a proxy this machine stopped for the update gets a plain restart command", () => {
    const lines = foregroundRestartAdvice({
      stoppedLocalProxy: true,
      port: 10100,
      proxyOnly: false,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Restart the local proxy\b/);
    expect(lines[0]).toEndWith("ocx start --port 10100");
  });

  test("proxy-only mode is preserved in the restart command", () => {
    const [line] = foregroundRestartAdvice({
      stoppedLocalProxy: true,
      port: 4242,
      proxyOnly: true,
    });
    expect(line).toEndWith("ocx start --port 4242 --proxy-only");
  });

  test("without local runtime state the caveat precedes a portless conditional command", () => {
    const lines = foregroundRestartAdvice({
      stoppedLocalProxy: false,
      port: 10100,
    });
    const text = lines.join("\n");
    // No unconditional "restart" instruction may be emitted for a port this machine does not own.
    expect(text).not.toMatch(/^Restart\b/m);
    expect(text).toContain("externally managed gateway or tunnel");
    expect(text).toContain("do not start a second proxy");
    // The port may belong to the tunnel (systemd socket, SSH forward), so the command must
    // not prescribe it, and the caveat must come before the command — not after it.
    expect(text).not.toContain("--port");
    const caveat = lines.findIndex((line) =>
      line.includes("do not start a second proxy"),
    );
    const command = lines.findIndex((line) =>
      line.startsWith("If this machine should run its own proxy"),
    );
    expect(caveat).toBeGreaterThanOrEqual(0);
    expect(command).toBeGreaterThan(caveat);
    expect(lines[command]).toEndWith("ocx start");
  });

  test("proxy-only mode survives in the conditional command too", () => {
    const command = foregroundRestartAdvice({
      stoppedLocalProxy: false,
      port: 10100,
      proxyOnly: true,
    }).find((line) =>
      line.startsWith("If this machine should run its own proxy"),
    );
    expect(command).toEndWith("ocx start --proxy-only");
  });

  test("npm launcher and Bun updater both route foreground guidance through the shared helper", () => {
    for (const source of [launcher, bunUpdater]) {
      expect(source).toContain("foregroundRestartAdvice(");
      expect(source).not.toMatch(/console\.log\(`[^`]*ocx start --port \$\{/);
    }
    expect(launcher).toMatch(
      /foregroundRestartAdvice\(\{ stoppedLocalProxy: hasRuntimeState,/,
    );
    expect(bunUpdater).toMatch(
      /const stoppedLocalProxy = Boolean\(readPid\(\) \|\| readRuntimePort\(\)\);/,
    );
  });

  test("no source file reintroduces an unconditional restart instruction", () => {
    const sources: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|mts|mjs)$/.test(entry.name)) sources.push(path);
      }
    };
    walk(join(root, "src"));
    walk(join(root, "bin"));
    // `Restart the proxy:  ocx start` is the old unconditional form. Only the shared helper
    // may decide between "restart the proxy you own" and the tunnel-safe conditional — every
    // other emitter (update prompt, launcher, Bun updater, dashboard worker) must stay quiet
    // or defer to the helper.
    const offenders = sources.filter((file) =>
      /Restart the proxy:\s+ocx start/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
