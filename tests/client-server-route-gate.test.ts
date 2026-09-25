import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_CLIENT_SHIM,
  CODEX_CLIENT_POWERSHELL_SHIM,
} from "../scripts/build-client-artifact";

const scratch = mkdtempSync(join(tmpdir(), "ocx-client-server-gate-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("client-only server route admission", () => {
  const serverCommands = ["app-server", "exec-server", "remote-control"];

  test.skipIf(process.platform === "win32")(
    "refuses to start native server commands when the central tunnel is down",
    () => {
      for (const command of serverCommands) {
        const dir = join(scratch, command);
        const home = join(dir, "home");
        mkdirSync(home, { recursive: true });
        const shim = join(dir, "codex.ocx-client");
        const ocx = join(dir, "ocx");
        const native = join(dir, "native-codex");
        const gateLog = join(dir, "gate.log");
        const nativeLog = join(dir, "native.log");
        writeFileSync(shim, CODEX_CLIENT_SHIM, { mode: 0o755 });
        writeFileSync(
          ocx,
          '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$OCX_GATE_LOG"\nexit "$OCX_GATE_EXIT"\n',
          { mode: 0o755 },
        );
        writeFileSync(
          native,
          '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$OCX_NATIVE_LOG"\n',
          { mode: 0o755 },
        );
        const env = {
          ...process.env,
          HOME: home,
          OCX_CLIENT_OCX_BIN: ocx,
          OCX_CLIENT_CODEX_BIN: native,
          OCX_GATE_LOG: gateLog,
          OCX_NATIVE_LOG: nativeLog,
        };
        const failed = Bun.spawnSync([shim, command, "--probe"], {
          env: { ...env, OCX_GATE_EXIT: "71" },
        });
        expect(failed.exitCode).toBe(69);
        expect(failed.stderr.toString()).toContain(
          "central OCX proxy unavailable",
        );
        expect(readFileSync(gateLog, "utf8")).toBe("ensure\n");
        expect(existsSync(nativeLog)).toBe(false);
        const healthy = Bun.spawnSync([shim, command, "--probe"], {
          env: { ...env, OCX_GATE_EXIT: "0" },
        });
        expect(healthy.exitCode).toBe(0);
        expect(readFileSync(gateLog, "utf8")).toBe("ensure\nensure\n");
        expect(readFileSync(nativeLog, "utf8")).toBe(command + " --probe\n");
        const offlineHelp = Bun.spawnSync([shim, "--version"], {
          env: { ...env, OCX_GATE_EXIT: "71" },
        });
        expect(offlineHelp.exitCode).toBe(0);
        expect(readFileSync(gateLog, "utf8")).toBe("ensure\nensure\n");
      }
    },
  );

  test("Windows client also gates all server entrypoints", () => {
    const skip = CODEX_CLIENT_POWERSHELL_SHIM.split("\n").find((line) =>
      line.startsWith("$skipEnsure ="),
    );
    expect(skip).toBeDefined();
    for (const command of serverCommands)
      expect(skip).not.toContain("'" + command + "'");
  });
});
