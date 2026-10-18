import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearPoolRotationState,
  peekRoundRobinAccount,
  pickRoundRobinAccount,
  POOL_ROTATION_STATE_FILENAME,
  seedPoolRotationAccount,
  uninstallPoolRotationPersistence,
} from "../src/codex/pool-rotation";
import { saveConfig } from "../src/config";
import { resetUsageLogMetricsObserverForTests } from "../src/observability/usage-log-metrics";
import { drainAndShutdown, startServer } from "../src/server";
import { setServerRef } from "../src/server/lifecycle";
import { getActiveMemoryWatchdog } from "../src/server/memory-watchdog";
import {
  installIsolatedCodexHome,
  type IsolatedCodexHome,
} from "./helpers/isolated-codex-home";

let home: string;
let statePath: string;
let codexHome: IsolatedCodexHome;
let server: ReturnType<typeof startServer> | undefined;
const envKeys = [
  "OPENCODEX_HOME",
  "OCX_SENTRY_DSN",
  "SENTRY_DSN",
  "OPENCODEX_ADMIN_AUTH_TOKEN",
] as const;
let previousEnv: Partial<Record<(typeof envKeys)[number], string>>;

beforeEach(() => {
  previousEnv = Object.fromEntries(
    envKeys.map((key) => [key, process.env[key]]),
  );
  uninstallPoolRotationPersistence();
  clearPoolRotationState();
  home = mkdtempSync(join(tmpdir(), "ocx-server-pool-persistence-"));
  codexHome = installIsolatedCodexHome("ocx-server-pool-persistence-codex-");
  statePath = join(home, POOL_ROTATION_STATE_FILENAME);
  process.env.OPENCODEX_HOME = home;
  delete process.env.OCX_SENTRY_DSN;
  delete process.env.SENTRY_DSN;
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "fixture-admin-token";
  saveConfig({
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "test",
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        disabled: true,
        liveModels: false,
        models: [],
      },
    },
    codexAccountPools: false,
  });
});

afterEach(async () => {
  try {
    if (server) await drainAndShutdown(server, 0);
  } finally {
    server = undefined;
    setServerRef(undefined);
    getActiveMemoryWatchdog()?.stop();
    resetUsageLogMetricsObserverForTests();
    uninstallPoolRotationPersistence();
    clearPoolRotationState();
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    codexHome.restore();
    rmSync(home, { recursive: true, force: true });
  }
});

describe("server pool rotation persistence", () => {
  test("startup restores the snapshot from OCX home and subsequent selections write there", () => {
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        pools: {
          codex: { activeKey: "saved", successes: 0, currentWeights: {} },
          cursor: {
            activeKey: "saved-cursor",
            successes: 0,
            currentWeights: {},
          },
        },
      }),
    );

    server = startServer(0);
    expect(peekRoundRobinAccount("codex", ["fresh", "saved"], 2)).toBe("saved");
    expect(peekRoundRobinAccount("cursor", ["fresh", "saved-cursor"], 2)).toBe(
      "saved-cursor",
    );
    seedPoolRotationAccount("codex", "updated");
    expect(
      JSON.parse(readFileSync(statePath, "utf8")).pools.codex.activeKey,
    ).toBe("updated");
    expect(existsSync(join(codexHome.path, POOL_ROTATION_STATE_FILENAME))).toBe(
      false,
    );
    expect(existsSync(`${statePath}.tmp`)).toBe(false);
  });

  test("startup keeps a selection already made in this process over the saved selection", () => {
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        pools: {
          codex: { activeKey: "saved", successes: 0, currentWeights: {} },
        },
      }),
    );
    const snapshot = readFileSync(statePath, "utf8");
    seedPoolRotationAccount("codex", "live");

    server = startServer(0);
    expect(readFileSync(statePath, "utf8")).toBe(snapshot);
    expect(pickRoundRobinAccount("codex", ["saved", "live"], 2)).toBe("live");
    expect(
      JSON.parse(readFileSync(statePath, "utf8")).pools.codex.activeKey,
    ).toBe("live");
  });
});
