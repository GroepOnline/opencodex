import http2 from "node:http2";
import { create, toBinary } from "@bufbuild/protobuf";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeConnectFrame } from "../src/adapters/cursor/framing";
import {
  AgentServerMessageSchema,
  InteractionUpdateSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import { clearPoolRotationState } from "../src/codex/pool-rotation";
import { saveConfig } from "../src/config";
import {
  clearCursorAccountPoolState,
  getCursorAccountHealthSnapshot,
} from "../src/oauth/cursor-routing";
import { getAccountSet, saveCredential, setActiveAccount } from "../src/oauth/store";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import {
  installIsolatedCodexHome,
  type IsolatedCodexHome,
} from "./helpers/isolated-codex-home";

const PROVIDER = "cursor";
let home = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

function turnEndedFrame(): Uint8Array {
  const message = create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: { case: "turnEnded", value: {} },
      }),
    },
  });
  return encodeConnectFrame(toBinary(AgentServerMessageSchema, message));
}

function endStreamFrame(error?: { code: string; message: string }): Uint8Array {
  return encodeConnectFrame(
    new TextEncoder().encode(JSON.stringify(error ? { error } : {})),
    { endStream: true },
  );
}

async function withCursorServer<T>(
  handler: (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => void,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = http2.createServer();
  server.on("stream", handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cursor fixture did not bind");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function config(baseUrl: string): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: PROVIDER,
    providers: {
      [PROVIDER]: {
        adapter: "cursor",
        baseUrl,
        allowPrivateNetwork: true,
        authMode: "oauth",
        models: ["auto"],
      },
    },
    cursorAccountPool: { enabled: true },
  };
}

async function seedAccounts(): Promise<string[]> {
  for (const suffix of ["a", "b"]) {
    await saveCredential(PROVIDER, {
      access: `token-${suffix}`,
      refresh: `refresh-${suffix}`,
      expires: Date.now() + 3_600_000,
      accountId: `account-${suffix}`,
      email: `${suffix}@example.test`,
    });
  }
  const ids = getAccountSet(PROVIDER)!.accounts.map(account => account.id);
  await setActiveAccount(PROVIDER, ids[0]!);
  return ids;
}

async function request(serverUrl: URL, threadId: string): Promise<Response> {
  return fetch(new URL("/v1/responses", serverUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-parent-thread-id": threadId,
    },
    body: JSON.stringify({
      model: "cursor/auto",
      input: "pool fixture",
      stream: false,
    }),
  });
}

async function withCursorRegistryBaseUrl<T>(baseUrl: string, run: () => Promise<T>): Promise<T> {
  const entry = getProviderRegistryEntry(PROVIDER);
  if (!entry) throw new Error("Cursor registry entry is missing");
  const original = entry.baseUrl;
  entry.baseUrl = baseUrl;
  try {
    return await run();
  } finally {
    entry.baseUrl = original;
  }
}

beforeEach(async () => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-cursor-pool-e2e-codex-");
  home = mkdtempSync(join(tmpdir(), "ocx-cursor-pool-e2e-"));
  process.env.OPENCODEX_HOME = home;
  clearCursorAccountPoolState();
  clearPoolRotationState();
  await seedAccounts();
});

afterEach(() => {
  clearCursorAccountPoolState();
  clearPoolRotationState();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  rmSync(home, { recursive: true, force: true });
});

describe("server Cursor account pool", () => {
  test("RESOURCE_EXHAUSTED rotates before output and succeeds on the second account", async () => {
    const attempts: string[] = [];
    await withCursorServer((stream, headers) => {
      const authorization = String(headers.authorization ?? "");
      attempts.push(authorization);
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      if (authorization === "Bearer token-a") {
        stream.end(endStreamFrame({
          code: "resource_exhausted",
          message: "RESOURCE_EXHAUSTED: hard quota exhausted",
        }));
        return;
      }
      stream.end(Buffer.concat([
        turnEndedFrame(),
        endStreamFrame(),
      ]));
    }, baseUrl => withCursorRegistryBaseUrl(baseUrl, async () => {
        saveConfig(config(baseUrl));
        const server = startServer(0);
        try {
          const response = await request(server.url, "cursor-pool-429");
          expect(response.status).toBe(200);
          expect(attempts).toEqual(["Bearer token-a", "Bearer token-b"]);
        } finally {
          await server.stop(true);
        }
      }));
  });

  test("an upstream Retry-After drives the cooldown of the rotated-away account", async () => {
    // Full chain: HTTP/2 `retry-after` response header → transport capture → error event →
    // rotateCursorAccountOnQuota. Without the header the cooldown falls back to the 60s default,
    // so asserting the source proves the interval is not being discarded en route.
    const [firstId] = getAccountSet(PROVIDER)!.accounts.map(account => account.id);
    await withCursorServer((stream, headers) => {
      const authorization = String(headers.authorization ?? "");
      if (authorization === "Bearer token-a") {
        stream.respond({ ":status": 200, "content-type": "application/connect+proto", "retry-after": "120" });
        stream.end(endStreamFrame({
          code: "resource_exhausted",
          message: "RESOURCE_EXHAUSTED: hard quota exhausted",
        }));
        return;
      }
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      stream.end(Buffer.concat([turnEndedFrame(), endStreamFrame()]));
    }, baseUrl => withCursorRegistryBaseUrl(baseUrl, async () => {
        saveConfig(config(baseUrl));
        const server = startServer(0);
        try {
          const response = await request(server.url, "cursor-pool-retry-after");
          expect(response.status).toBe(200);
          const snapshot = getCursorAccountHealthSnapshot(firstId!);
          expect(snapshot?.cooldownSource).toBe("retry-after");
          expect(snapshot!.cooldownUntil!).toBeGreaterThan(Date.now() + 90_000);
        } finally {
          await server.stop(true);
        }
      }));
  });

  test("EOF and generic 502 errors do not rotate or cool the account", async () => {
    const [firstId] = getAccountSet(PROVIDER)!.accounts.map(account => account.id);
    const attempts: string[] = [];
    let outcome: "eof" | "502" = "eof";
    await withCursorServer((stream, headers) => {
      attempts.push(String(headers.authorization ?? ""));
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      if (outcome === "eof") {
        stream.end();
      } else {
        stream.end(endStreamFrame({
          code: "internal",
          message: "generic upstream error: post-commit 502",
        }));
      }
    }, baseUrl => withCursorRegistryBaseUrl(baseUrl, async () => {
        saveConfig(config(baseUrl));
        const server = startServer(0);
        try {
          for (outcome of ["eof", "502"]) {
            attempts.length = 0;
            await request(server.url, `cursor-pool-${outcome}`);
            expect(attempts).toEqual(["Bearer token-a"]);
            expect(getCursorAccountHealthSnapshot(firstId!)).toBeNull();
          }
        } finally {
          await server.stop(true);
        }
      }));
  });
});
