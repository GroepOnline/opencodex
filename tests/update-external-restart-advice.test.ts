import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { foregroundRestartAdvice } from "../src/update/restart-advice.mjs";

const root = join(import.meta.dir, "..");
const launcher = readFileSync(join(root, "bin", "ocx.mjs"), "utf8");
const bunUpdater = readFileSync(join(root, "src", "update", "index.ts"), "utf8");

describe("update does not tell external tunnel clients to start a competing proxy", () => {
  test("a proxy this machine stopped for the update gets a plain restart command", () => {
    const lines = foregroundRestartAdvice({ stoppedLocalProxy: true, port: 10100, proxyOnly: false });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Restart the local proxy\b/);
    expect(lines[0]).toEndWith("ocx start --port 10100");
  });

  test("proxy-only mode is preserved in the restart command", () => {
    const [line] = foregroundRestartAdvice({ stoppedLocalProxy: true, port: 4242, proxyOnly: true });
    expect(line).toEndWith("ocx start --port 4242 --proxy-only");
  });

  test("without local runtime state the start command is only conditional", () => {
    const lines = foregroundRestartAdvice({ stoppedLocalProxy: false, port: 10100 });
    const text = lines.join("\n");
    // No unconditional "restart" instruction may be emitted for a port this machine does not own.
    expect(text).not.toMatch(/^Restart\b/m);
    expect(lines.find((line) => line.includes("ocx start --port 10100"))).toMatch(/^If this machine should run its own proxy\b/);
    expect(text).toContain("externally managed gateway or tunnel");
    expect(text).toContain("do not start a second proxy");
  });

  test("npm launcher and Bun updater both route foreground guidance through the shared helper", () => {
    for (const source of [launcher, bunUpdater]) {
      expect(source).toContain("foregroundRestartAdvice(");
      expect(source).not.toMatch(/console\.log\(`[^`]*ocx start --port \$\{/);
    }
    expect(launcher).toMatch(/foregroundRestartAdvice\(\{ stoppedLocalProxy: hasRuntimeState,/);
    expect(bunUpdater).toMatch(/const stoppedLocalProxy = Boolean\(readPid\(\) \|\| readRuntimePort\(\)\);/);
  });
});
