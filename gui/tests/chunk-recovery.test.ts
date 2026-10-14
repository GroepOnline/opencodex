import { expect, test } from "bun:test";
import { isChunkLoadError, recoverStaleChunk } from "../src/app/chunk-recovery";

const OLD_SHA = "0123456789abcdef0123456789abcdef01234567";
const NEW_SHA = "abcdef0123456789abcdef0123456789abcdef01";
const NEXT_SHA = "9876543210abcdef9876543210abcdef98765432";

function setup(response: () => Promise<Response>) {
  const values = new Map<string, string>();
  const calls: string[] = [];
  let reloads = 0;
  return {
    calls,
    values,
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

const chunkError = new TypeError("Failed to fetch dynamically imported module");
const reloadKey = "opencodex:chunk-reload-attempted";

test.each([
  "Failed to fetch dynamically imported module: /assets/page.js",
  "error loading dynamically imported module",
  "Importing a module script failed.",
  "Unable to preload CSS for /assets/page.css",
  "ChunkLoadError: timeout",
  "Loading chunk settings-1.a failed.",
])("recognizes browser chunk failure: %s", (message) => {
  expect(isChunkLoadError(new Error(message))).toBe(true);
  expect(isChunkLoadError(message)).toBe(true);
});

test.each([
  "Failed to fetch",
  "NetworkError when attempting to fetch resource",
  "Cannot read properties of undefined",
  "Loading chunk settings succeeded",
  "",
  null,
  undefined,
  { message: "Failed to fetch dynamically imported module" },
])("does not mistake unrelated failures for chunks: %j", (error) => {
  expect(isChunkLoadError(error)).toBe(false);
});

test.each([
  null,
  "",
  "unknown",
  OLD_SHA.slice(0, 39),
  `${OLD_SHA}0`,
  "g".repeat(40),
  ` ${OLD_SHA}`,
])(
  "an invalid client identity cannot probe or reload: %j",
  async (clientSha) => {
    const state = setup(async () => Response.json({ gitSha: NEW_SHA }));
    expect(
      await recoverStaleChunk(chunkError, { ...state.options, clientSha }),
    ).toBe(false);
    expect(state.calls).toEqual([]);
    expect(state.values.size).toBe(0);
    expect(state.reloads).toBe(0);
  },
);

test.each(
  [
    null,
    [],
    "not an identity object",
    {},
    { gitSha: null },
    { gitSha: 123 },
    { gitSha: {} },
    { gitSha: "" },
    { gitSha: "unknown" },
    { gitSha: NEW_SHA.slice(0, 39) },
    { gitSha: `${NEW_SHA}0` },
    { gitSha: "g".repeat(40) },
  ].map((body) => [body] as const),
)(
  "an unverified runtime identity leaves recovery inactive: %j",
  async (body) => {
    const state = setup(async () => Response.json(body));
    expect(await recoverStaleChunk(chunkError, state.options)).toBe(false);
    expect(state.calls).toEqual(["/healthz"]);
    expect(state.values.size).toBe(0);
    expect(state.reloads).toBe(0);
  },
);

test.each([401, 404, 503])(
  "HTTP %i cannot prove a changed release",
  async (status) => {
    const state = setup(async () =>
      Response.json({ gitSha: NEW_SHA }, { status }),
    );
    expect(await recoverStaleChunk(chunkError, state.options)).toBe(false);
    expect(state.values.size).toBe(0);
    expect(state.reloads).toBe(0);
  },
);

test("malformed JSON does not reload or poison the next recovery", async () => {
  let malformed = true;
  const state = setup(async () =>
    malformed
      ? new Response("<html>offline</html>")
      : Response.json({ gitSha: NEW_SHA }),
  );
  expect(await recoverStaleChunk(chunkError, state.options)).toBe(false);
  expect(state.reloads).toBe(0);
  expect(state.values.size).toBe(0);

  malformed = false;
  expect(await recoverStaleChunk(chunkError, state.options)).toBe(true);
  expect(state.calls).toEqual(["/healthz", "/healthz"]);
  expect(state.reloads).toBe(1);
});

test("runtime identity comparison ignores case and surrounding whitespace", async () => {
  const state = setup(async () =>
    Response.json({ gitSha: ` \n${OLD_SHA.toUpperCase()}\t` }),
  );
  expect(await recoverStaleChunk(chunkError, state.options)).toBe(false);
  expect(state.values.size).toBe(0);
  expect(state.reloads).toBe(0);
});

test("a persisted session marker prevents reload after the module restarts", async () => {
  const state = setup(async () => Response.json({ gitSha: ` ${NEW_SHA} ` }));
  state.values.set(reloadKey, NEW_SHA.toUpperCase());
  expect(await recoverStaleChunk(chunkError, state.options)).toBe(false);
  expect(state.values.get(reloadKey)).toBe(NEW_SHA.toUpperCase());
  expect(state.reloads).toBe(0);
});

test("stores the trimmed deployment identity before reloading", async () => {
  const runtimeSha = NEW_SHA.toUpperCase();
  const state = setup(async () =>
    Response.json({ gitSha: `\n${runtimeSha} ` }),
  );
  let reloads = 0;
  expect(
    await recoverStaleChunk(chunkError, {
      ...state.options,
      clientSha: OLD_SHA.toUpperCase(),
      reload: () => {
        expect(state.values.get(reloadKey)).toBe(runtimeSha);
        reloads += 1;
      },
    }),
  ).toBe(true);
  expect(reloads).toBe(1);
});

test.each(["getItem", "setItem"] as const)(
  "storage %s failure prevents an unguarded reload",
  async (method) => {
    const state = setup(async () => Response.json({ gitSha: NEW_SHA }));
    const options = {
      ...state.options,
      storage: {
        ...state.options.storage,
        [method]: () => {
          throw new Error("storage blocked");
        },
      },
    };
    expect(await recoverStaleChunk(chunkError, options)).toBe(false);
    expect(state.reloads).toBe(0);
    expect(state.values.size).toBe(0);
    expect(await recoverStaleChunk(chunkError, state.options)).toBe(true);
    expect(state.reloads).toBe(1);
  },
);

test("a failed reload retains its marker to prevent repeated automatic attempts", async () => {
  const state = setup(async () => Response.json({ gitSha: NEW_SHA }));
  expect(
    await recoverStaleChunk(chunkError, {
      ...state.options,
      reload: () => {
        throw new Error("reload unavailable");
      },
    }),
  ).toBe(false);
  expect(state.values.get(reloadKey)).toBe(NEW_SHA);
  expect(await recoverStaleChunk(chunkError, state.options)).toBe(false);
  expect(state.reloads).toBe(0);
});

test.each([true, false])(
  "concurrent boundaries share one probe, then release it (success=%s)",
  async (success) => {
    let complete!: (response: Response) => void;
    const state = setup(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const otherBoundary = setup(async () =>
      Response.json({ gitSha: NEXT_SHA }),
    );
    const first = recoverStaleChunk(chunkError, state.options);
    const second = recoverStaleChunk(chunkError, otherBoundary.options);
    expect(second).toBe(first);
    expect(state.calls).toEqual(["/healthz"]);
    expect(otherBoundary.calls).toEqual([]);
    expect(
      await recoverStaleChunk(
        new Error("render exploded"),
        otherBoundary.options,
      ),
    ).toBe(false);

    complete(
      Response.json({ gitSha: NEW_SHA }, { status: success ? 200 : 503 }),
    );
    expect(await first).toBe(success);
    expect(await second).toBe(success);
    expect(state.reloads).toBe(success ? 1 : 0);
    expect(otherBoundary.reloads).toBe(0);

    expect(await recoverStaleChunk(chunkError, otherBoundary.options)).toBe(
      true,
    );
    expect(otherBoundary.calls).toEqual(["/healthz"]);
    expect(otherBoundary.reloads).toBe(1);
  },
);

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
  const builder = dockerfile
    .split("FROM root-deps AS build\n")[1]
    ?.split("\nFROM oven/bun:")[0];
  expect(builder).toContain("ARG VCS_REF=unknown");
  expect(builder).toContain("ENV OPENCODEX_GIT_SHA=${VCS_REF}");

  // Simulate the build stage: .git is absent, but GitHub supplied a full VCS_REF.
  const imageSha = "f".repeat(40);
  const original = process.env.OPENCODEX_GIT_SHA;
  try {
    process.env.OPENCODEX_GIT_SHA = imageSha;
    const { default: config } =
      await import("../vite.config.ts?image-sha-test");
    const define = (config as { define?: Record<string, string> }).define;
    expect(define?.__APP_GIT_SHA__).toBe(JSON.stringify(imageSha));
  } finally {
    if (original === undefined) delete process.env.OPENCODEX_GIT_SHA;
    else process.env.OPENCODEX_GIT_SHA = original;
  }
});
