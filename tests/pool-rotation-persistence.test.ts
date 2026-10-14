import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearPoolRotationState,
  installPoolRotationPersistence,
  notePoolRotationFailure,
  notePoolRotationSuccess,
  peekRoundRobinAccount,
  pickRoundRobinAccount,
  POOL_ROTATION_STATE_FILENAME,
  POOL_KEY_ANTHROPIC,
  POOL_KEY_ANTIGRAVITY,
  POOL_KEY_CODEX,
  POOL_KEY_CURSOR,
  seedPoolRotationAccount,
  uninstallPoolRotationPersistence,
} from "../src/codex/pool-rotation";

let root: string;
let statePath: string;

beforeEach(() => {
  uninstallPoolRotationPersistence();
  clearPoolRotationState();
  root = mkdtempSync(join(tmpdir(), "ocx-pool-rotation-persistence-"));
  statePath = join(root, POOL_ROTATION_STATE_FILENAME);
});

afterEach(() => {
  uninstallPoolRotationPersistence();
  clearPoolRotationState();
  rmSync(root, { recursive: true, force: true });
});

interface Snapshot {
  version: number;
  pools: Record<
    string,
    {
      activeKey?: string;
      successes: number;
      currentWeights: Record<string, number>;
    }
  >;
}

function readSnapshot(): Snapshot {
  return JSON.parse(readFileSync(statePath, "utf8"));
}

/** Clear only memory so the next install exercises the disk loader. */
function restartPersistence(): void {
  uninstallPoolRotationPersistence();
  clearPoolRotationState();
  installPoolRotationPersistence(statePath);
}

test("no disk state without an install", () => {
  pickRoundRobinAccount("codex", ["a", "b"], 1);
  expect(existsSync(statePath)).toBe(false);
});

test("a selection mutates and writes version 1 state", () => {
  installPoolRotationPersistence(statePath);
  pickRoundRobinAccount("codex", ["a", "b"], 1);
  expect(existsSync(statePath)).toBe(true);
  expect(readSnapshot()).toEqual({
    version: 1,
    pools: { codex: { successes: 0, currentWeights: { a: -1, b: 1 } } },
  });
  expect(existsSync(`${statePath}.tmp`)).toBe(false);
});

test("a seeded account survives clearing memory and reinstalling from disk", () => {
  installPoolRotationPersistence(statePath);
  seedPoolRotationAccount("codex", "seeded");
  restartPersistence();
  // Put the saved account second: a fresh ring would select 'other'.
  expect(peekRoundRobinAccount("codex", ["other", "seeded"], 1)).toBe("seeded");
  expect(pickRoundRobinAccount("codex", ["other", "seeded"], 1)).toBe("seeded");
});

test("clearing removes the persisted snapshot", () => {
  installPoolRotationPersistence(statePath);
  seedPoolRotationAccount("codex", "seeded");
  expect(existsSync(statePath)).toBe(true);
  clearPoolRotationState();
  expect(existsSync(statePath)).toBe(false);
});

test("a corrupt state file is ignored, not fatal", () => {
  writeFileSync(statePath, "{not json", { mode: 0o600 });
  installPoolRotationPersistence(statePath);
  expect(existsSync(statePath)).toBe(true);
  const picked = pickRoundRobinAccount("codex", ["a", "b"], 1);
  expect(picked).toBe("a");
  expect(readSnapshot().version).toBe(1);
});

test("round-robin weights continue across repeated restarts without a sticky account", () => {
  installPoolRotationPersistence(statePath);
  const ids = ["a", "b", "c"];
  for (const expected of ["a", "b", "c", "a"]) {
    expect(pickRoundRobinAccount("codex", ids, 1)).toBe(expected);
    expect(readSnapshot().pools.codex.activeKey).toBeUndefined();
    restartPersistence();
  }
});

test("all supported pools restore independent rotation rings", () => {
  installPoolRotationPersistence(statePath);
  const pools = [
    POOL_KEY_CODEX,
    POOL_KEY_ANTHROPIC,
    POOL_KEY_ANTIGRAVITY,
    POOL_KEY_CURSOR,
  ];
  const ids = ["a", "b", "c"];
  pools.forEach((pool, index) => {
    for (let i = 0; i <= index; i++) pickRoundRobinAccount(pool, ids, 1);
  });
  expect(Object.keys(readSnapshot().pools).sort()).toEqual([...pools].sort());
  restartPersistence();
  pools.forEach((pool, index) => {
    expect(pickRoundRobinAccount(pool, ids, 1)).toBe(
      ids[(index + 1) % ids.length],
    );
  });
});

test("seed replaces persisted weights and counters for the manually selected account", () => {
  installPoolRotationPersistence(statePath);
  pickRoundRobinAccount("codex", ["a", "b"], 3);
  notePoolRotationSuccess("codex", "a", 3);
  seedPoolRotationAccount("codex", "b");
  expect(readSnapshot().pools.codex).toEqual({
    activeKey: "b",
    successes: 0,
    currentWeights: {},
  });
  restartPersistence();
  expect(pickRoundRobinAccount("codex", ["a", "b"], 3)).toBe("b");
});

test("install preserves live state instead of replacing it with an older disk snapshot", () => {
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      pools: {
        codex: { activeKey: "saved", successes: 0, currentWeights: {} },
        cursor: { activeKey: "saved-cursor", successes: 0, currentWeights: {} },
      },
    }),
  );
  seedPoolRotationAccount("codex", "live");
  const diskBefore = readFileSync(statePath, "utf8");
  installPoolRotationPersistence(statePath);
  expect(readFileSync(statePath, "utf8")).toBe(diskBefore);
  expect(pickRoundRobinAccount("codex", ["saved", "live"], 2)).toBe("live");
  // A process with live state does not merge another pool from the old snapshot.
  expect(
    peekRoundRobinAccount("cursor", ["fresh-cursor", "saved-cursor"], 2),
  ).toBe("fresh-cursor");
});

test("reinstall does not reload a snapshot edited after the first install", () => {
  installPoolRotationPersistence(statePath);
  seedPoolRotationAccount("codex", "live");
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      pools: {
        codex: { activeKey: "edited", successes: 0, currentWeights: {} },
      },
    }),
  );
  installPoolRotationPersistence(statePath);
  expect(pickRoundRobinAccount("codex", ["edited", "live"], 2)).toBe("live");
  expect(readSnapshot().pools.codex.activeKey).toBe("live");
});

test("uninstall retains live rotation while leaving the last snapshot untouched", () => {
  installPoolRotationPersistence(statePath);
  expect(pickRoundRobinAccount("codex", ["a", "b"], 1)).toBe("a");
  const snapshot = readFileSync(statePath, "utf8");
  uninstallPoolRotationPersistence();
  expect(pickRoundRobinAccount("codex", ["a", "b"], 1)).toBe("b");
  seedPoolRotationAccount("cursor", "c");
  clearPoolRotationState("cursor");
  expect(readFileSync(statePath, "utf8")).toBe(snapshot);
});

test("installing a new path flushes live state only to the new destination", () => {
  installPoolRotationPersistence(statePath);
  seedPoolRotationAccount("codex", "original");
  const snapshot = readFileSync(statePath, "utf8");
  const secondPath = join(root, "second", POOL_ROTATION_STATE_FILENAME);
  installPoolRotationPersistence(secondPath);
  seedPoolRotationAccount("codex", "updated");
  expect(readFileSync(statePath, "utf8")).toBe(snapshot);
  expect(
    JSON.parse(readFileSync(secondPath, "utf8")).pools.codex.activeKey,
  ).toBe("updated");
});

test("peek never creates a snapshot or advances persisted state", () => {
  installPoolRotationPersistence(statePath);
  expect(peekRoundRobinAccount("codex", ["a", "b"], 2)).toBe("a");
  expect(existsSync(statePath)).toBe(false);
  pickRoundRobinAccount("codex", ["a", "b"], 1);
  const snapshot = readFileSync(statePath, "utf8");
  const write = spyOn(fs, "writeFileSync");
  try {
    expect(peekRoundRobinAccount("codex", ["a", "b"], 1)).toBe("b");
    expect(peekRoundRobinAccount("codex", ["a", "b"], 1)).toBe("b");
    expect(peekRoundRobinAccount("unused", [], 1)).toBeNull();
    expect(write).not.toHaveBeenCalled();
  } finally {
    write.mockRestore();
  }
  expect(readFileSync(statePath, "utf8")).toBe(snapshot);
  expect(pickRoundRobinAccount("codex", ["a", "b"], 1)).toBe("b");
});

test("success notes avoid disk writes until the sticky limit releases the account", () => {
  installPoolRotationPersistence(statePath);
  pickRoundRobinAccount("codex", ["a", "b"], 3);
  const snapshot = readFileSync(statePath, "utf8");
  const write = spyOn(fs, "writeFileSync");
  try {
    notePoolRotationSuccess("codex", "a", 3);
    notePoolRotationSuccess("codex", "a", 3);
    notePoolRotationSuccess("unknown", "a", 3);
    expect(write).not.toHaveBeenCalled();
    expect(readFileSync(statePath, "utf8")).toBe(snapshot);
    notePoolRotationSuccess("codex", "a", 3);
    expect(write).toHaveBeenCalledTimes(1);
  } finally {
    write.mockRestore();
  }
  expect(readSnapshot().pools.codex).toEqual({
    successes: 0,
    currentWeights: { a: -1, b: 1 },
  });
  restartPersistence();
  expect(pickRoundRobinAccount("codex", ["a", "b"], 3)).toBe("b");
});

test("only a failure for the active account persists a sticky release", () => {
  installPoolRotationPersistence(statePath);
  pickRoundRobinAccount("codex", ["a", "b"], 3);
  notePoolRotationSuccess("codex", "a", 3);
  const write = spyOn(fs, "writeFileSync");
  try {
    notePoolRotationFailure("codex", "b");
    notePoolRotationFailure("unknown", "a");
    expect(write).not.toHaveBeenCalled();
    notePoolRotationFailure("codex", "a");
    expect(write).toHaveBeenCalledTimes(1);
  } finally {
    write.mockRestore();
  }
  expect(readSnapshot().pools.codex.successes).toBe(0);
  expect(readSnapshot().pools.codex.activeKey).toBeUndefined();
  restartPersistence();
  expect(pickRoundRobinAccount("codex", ["a", "b"], 3)).toBe("b");
});

test("a restored sticky success count releases at the remaining limit", () => {
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      pools: {
        codex: {
          activeKey: "a",
          successes: 2,
          currentWeights: { a: -1, b: 1 },
        },
      },
    }),
  );
  installPoolRotationPersistence(statePath);
  expect(pickRoundRobinAccount("codex", ["a", "b"], 3)).toBe("a");
  notePoolRotationSuccess("codex", "a", 3);
  expect(readSnapshot().pools.codex.activeKey).toBeUndefined();
  restartPersistence();
  expect(pickRoundRobinAccount("codex", ["a", "b"], 3)).toBe("b");
});

test("a saved account that is no longer eligible is replaced and persisted", () => {
  installPoolRotationPersistence(statePath);
  seedPoolRotationAccount("codex", "removed");
  restartPersistence();
  expect(pickRoundRobinAccount("codex", ["replacement"], 2)).toBe(
    "replacement",
  );
  expect(readSnapshot().pools.codex.activeKey).toBe("replacement");
  expect(readSnapshot().pools.codex.successes).toBe(0);
});

test("clearing one pool keeps the others and clearing the last removes both snapshot files", () => {
  installPoolRotationPersistence(statePath);
  seedPoolRotationAccount("codex", "a");
  seedPoolRotationAccount("cursor", "b");
  clearPoolRotationState("codex");
  expect(Object.keys(readSnapshot().pools)).toEqual(["cursor"]);
  restartPersistence();
  expect(peekRoundRobinAccount("cursor", ["a", "b"], 2)).toBe("b");
  expect(peekRoundRobinAccount("codex", ["b", "a"], 2)).toBe("b");
  writeFileSync(`${statePath}.tmp`, "stale temporary snapshot");
  clearPoolRotationState("cursor");
  expect(existsSync(statePath)).toBe(false);
  expect(existsSync(`${statePath}.tmp`)).toBe(false);
});

test.each([
  "null",
  "42",
  "{}",
  '{"version":1}',
  '{"version":1,"pools":null}',
  '{"version":1,"pools":"invalid"}',
])("ignores unusable snapshot %s", (raw) => {
  writeFileSync(statePath, raw);
  expect(() => installPoolRotationPersistence(statePath)).not.toThrow();
  expect(pickRoundRobinAccount("codex", ["a", "b"], 2)).toBe("a");
  expect(readSnapshot().pools.codex.activeKey).toBe("a");
});

test.each([
  null,
  "invalid",
  { activeKey: 123 },
  { activeKey: null },
  { activeKey: "invalid", successes: -1 },
  { activeKey: "invalid", successes: "NaN" },
  { activeKey: "invalid", successes: "Infinity" },
])("skips malformed pool %j while loading other valid pools", (invalid) => {
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      pools: {
        codex: invalid,
        cursor: { activeKey: "saved", successes: 0, currentWeights: {} },
      },
    }),
  );
  installPoolRotationPersistence(statePath);
  expect(pickRoundRobinAccount("codex", ["fresh", "invalid"], 2)).toBe("fresh");
  expect(pickRoundRobinAccount("cursor", ["fresh", "saved"], 2)).toBe("saved");
});

test("defaults missing counters and weights for a saved active account", () => {
  writeFileSync(
    statePath,
    JSON.stringify({ version: 1, pools: { codex: { activeKey: "saved" } } }),
  );
  installPoolRotationPersistence(statePath);
  expect(pickRoundRobinAccount("codex", ["fresh", "saved"], 2)).toBe("saved");
  expect(readSnapshot().pools.codex).toEqual({
    activeKey: "saved",
    successes: 0,
    currentWeights: {},
  });
});

test("ignores non-finite saved weights while retaining valid ring weights", () => {
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      pools: {
        codex: {
          successes: 0,
          currentWeights: { a: -1, b: 1, nan: "NaN", infinite: "Infinity" },
        },
      },
    }),
  );
  installPoolRotationPersistence(statePath);
  expect(pickRoundRobinAccount("codex", ["a", "b"], 1)).toBe("b");
  expect(readSnapshot().pools.codex.currentWeights).toEqual({ a: 0, b: 0 });
});

test("an unreadable snapshot path does not stop in-memory rotation", () => {
  mkdirSync(statePath);
  expect(() => installPoolRotationPersistence(statePath)).not.toThrow();
  expect(pickRoundRobinAccount("codex", ["a", "b"], 1)).toBe("a");
  expect(pickRoundRobinAccount("codex", ["a", "b"], 1)).toBe("b");
  expect(existsSync(`${statePath}.tmp`)).toBe(false);
  expect(() => clearPoolRotationState()).not.toThrow();
});

test.skipIf(process.platform === "win32")(
  "creates private nested directories and repairs a stale temp file's permissions",
  () => {
    const privateDir = join(root, "nested", "private");
    statePath = join(privateDir, POOL_ROTATION_STATE_FILENAME);
    installPoolRotationPersistence(statePath);
    seedPoolRotationAccount("codex", "a");
    expect(statSync(privateDir).mode & 0o777).toBe(0o700);
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    writeFileSync(`${statePath}.tmp`, "stale", { mode: 0o666 });
    chmodSync(`${statePath}.tmp`, 0o666);
    seedPoolRotationAccount("codex", "b");
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(readSnapshot().pools.codex.activeKey).toBe("b");
    expect(existsSync(`${statePath}.tmp`)).toBe(false);
  },
);

test("a failed atomic rename preserves the last snapshot and removes the temporary file", () => {
  installPoolRotationPersistence(statePath);
  pickRoundRobinAccount("codex", ["a", "b", "c"], 1);
  const snapshot = readFileSync(statePath, "utf8");
  const rename = spyOn(fs, "renameSync").mockImplementation(() => {
    throw new Error("fixture rename failure");
  });
  try {
    expect(pickRoundRobinAccount("codex", ["a", "b", "c"], 1)).toBe("b");
    expect(rename).toHaveBeenCalledWith(`${statePath}.tmp`, statePath);
    expect(readFileSync(statePath, "utf8")).toBe(snapshot);
    expect(existsSync(`${statePath}.tmp`)).toBe(false);
  } finally {
    rename.mockRestore();
  }
  expect(pickRoundRobinAccount("codex", ["a", "b", "c"], 1)).toBe("c");
  restartPersistence();
  expect(pickRoundRobinAccount("codex", ["a", "b", "c"], 1)).toBe("a");
});

test("failed directory creation leaves rotation usable and later writes recover", () => {
  const parent = join(root, "blocked");
  writeFileSync(parent, "fixture blocking file");
  statePath = join(parent, POOL_ROTATION_STATE_FILENAME);
  installPoolRotationPersistence(statePath);
  expect(pickRoundRobinAccount("codex", ["a", "b"], 1)).toBe("a");
  expect(existsSync(statePath)).toBe(false);
  expect(existsSync(`${statePath}.tmp`)).toBe(false);
  rmSync(parent);
  expect(pickRoundRobinAccount("codex", ["a", "b"], 1)).toBe("b");
  expect(readSnapshot().version).toBe(1);
  restartPersistence();
  expect(pickRoundRobinAccount("codex", ["a", "b"], 1)).toBe("a");
});
