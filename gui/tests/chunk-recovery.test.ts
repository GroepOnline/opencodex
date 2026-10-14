import { expect, test } from "bun:test";
import { recoverStaleChunk } from "../src/app/chunk-recovery";

const OLD_SHA = "0123456789abcdef0123456789abcdef01234567";
const NEW_SHA = "abcdef0123456789abcdef0123456789abcdef01";

function setup(response: () => Promise<Response>) {
  const values = new Map<string, string>();
  const calls: string[] = [];
  let reloads = 0;
  return {
    calls,
    get reloads() {
      return reloads;
    },
    options: {
      clientSha: OLD_SHA,
      fetcher: async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(String(input));
        expect(init?.cache).toBe("no-store");
        return response();
      },
      storage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          values.set(key, value);
        },
      },
      reload: () => {
        reloads += 1;
      },
    },
  };
}

test("a stale tab reloads once when public provenance proves a new checkout", async () => {
  const state = setup(async () => Response.json({ gitSha: NEW_SHA }));
  const chunkError = new TypeError(
    "Failed to fetch dynamically imported module",
  );
  expect(await recoverStaleChunk(chunkError, state.options)).toBe(true);
  expect(await recoverStaleChunk(chunkError, state.options)).toBe(false);
  expect(state.calls).toEqual(["/healthz"]);
  expect(state.reloads).toBe(1);
});

test("same-release missing chunks stay actionable without an automatic reload", async () => {
  const state = setup(async () => Response.json({ gitSha: OLD_SHA }));
  expect(
    await recoverStaleChunk(
      new TypeError("Failed to fetch dynamically imported module"),
      state.options,
    ),
  ).toBe(false);
  expect(state.reloads).toBe(0);
});

test("a provenance network failure leaves the error visible without reloading", async () => {
  const state = setup(async () => {
    throw new TypeError("network unavailable");
  });
  expect(
    await recoverStaleChunk(
      new TypeError("Failed to fetch dynamically imported module"),
      state.options,
    ),
  ).toBe(false);
  expect(state.reloads).toBe(0);
});

test("ordinary page errors do not probe release identity", async () => {
  const state = setup(async () => Response.json({ gitSha: NEW_SHA }));
  expect(
    await recoverStaleChunk(new Error("render exploded"), state.options),
  ).toBe(false);
  expect(state.calls).toEqual([]);
  expect(state.reloads).toBe(0);
});

test("unknown build identity fails closed", async () => {
  const state = setup(async () => Response.json({ gitSha: NEW_SHA }));
  expect(
    await recoverStaleChunk(
      new TypeError("Failed to fetch dynamically imported module"),
      {
        ...state.options,
        clientSha: null,
      },
    ),
  ).toBe(false);
  expect(state.calls).toEqual([]);
  expect(state.reloads).toBe(0);
});
