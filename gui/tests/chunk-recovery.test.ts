import { expect, test } from "bun:test";
import { recoverStaleChunk } from "../src/app/chunk-recovery";

const OLD_SHA = "0123456789abcdef0123456789abcdef01234567";
const NEW_SHA = "abcdef0123456789abcdef0123456789abcdef01";
const NEXT_SHA = "9876543210abcdef9876543210abcdef98765432";

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

test("each changed release reloads once without looping on the same target", async () => {
  let runtimeSha = NEW_SHA;
  const state = setup(async () => Response.json({ gitSha: runtimeSha }));
  const chunkError = new TypeError(
    "Failed to fetch dynamically imported module",
  );

  expect(await recoverStaleChunk(chunkError, state.options)).toBe(true);
  expect(state.reloads).toBe(1);

  // A reload that still serves the old GUI must not loop for the same deployment.
  expect(await recoverStaleChunk(chunkError, state.options)).toBe(false);
  expect(state.reloads).toBe(1);

  // A later deployment has a distinct target SHA and gets its own recovery attempt.
  runtimeSha = NEXT_SHA;
  expect(await recoverStaleChunk(chunkError, state.options)).toBe(true);
  expect(state.reloads).toBe(2);
  expect(await recoverStaleChunk(chunkError, state.options)).toBe(false);
  expect(state.calls).toEqual(["/healthz", "/healthz", "/healthz", "/healthz"]);
  expect(state.reloads).toBe(2);
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

test("only full 40-character checkout identities can trigger recovery", async () => {
  const state = setup(async () =>
    Response.json({ gitSha: NEW_SHA.slice(0, 7) }),
  );
  const chunkError = new TypeError(
    "Failed to fetch dynamically imported module",
  );

  expect(
    await recoverStaleChunk(chunkError, {
      ...state.options,
      clientSha: OLD_SHA.slice(0, 7),
    }),
  ).toBe(false);
  expect(state.calls).toEqual([]);

  expect(await recoverStaleChunk(chunkError, state.options)).toBe(false);
  expect(state.calls).toEqual(["/healthz"]);
  expect(state.reloads).toBe(0);
});

test("container build identity reaches the Vite client bundle", async () => {
  const dockerfile = await Bun.file(
    new URL("../../Dockerfile", import.meta.url),
  ).text();
  const builder = dockerfile.split("FROM root-deps AS build\\n")[1]?.split(
    "\\nFROM oven/bun:",
  )[0];
  expect(builder).toContain("ARG VCS_REF=unknown");
  expect(builder).toContain("ENV OPENCODEX_GIT_SHA=${VCS_REF}");

  // Simulate the build stage: .git is absent, but GitHub supplied a full VCS_REF.
  const imageSha = "f".repeat(40);
  const original = process.env.OPENCODEX_GIT_SHA;
  try {
    process.env.OPENCODEX_GIT_SHA = imageSha;
    const { default: config } = await import("../vite.config.ts?image-sha-test");
    const define = (config as { define?: Record<string, string> }).define;
    expect(define?.__APP_GIT_SHA__).toBe(JSON.stringify(imageSha));
  } finally {
    if (original === undefined) delete process.env.OPENCODEX_GIT_SHA;
    else process.env.OPENCODEX_GIT_SHA = original;
  }
});
