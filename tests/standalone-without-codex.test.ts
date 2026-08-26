import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import {
  installStandaloneRuntimeEnv,
  type StandaloneRuntimeEnv,
} from "./helpers/standalone-env";

let env: StandaloneRuntimeEnv | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => {
  env = installStandaloneRuntimeEnv("ocx-standalone-proof-");
});

afterEach(() => {
  upstream?.stop(true);
  upstream = null;
  env?.restore();
  env = null;
});

function mockResponsesUpstream(onRequest?: () => void) {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.endsWith("/responses")) {
        return Response.json(
          { error: { message: `unexpected path ${url.pathname}` } },
          { status: 404 },
        );
      }
      await req.json();
      onRequest?.();
      return Response.json({
        id: "resp_standalone",
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "ok" }],
          },
        ],
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      });
    },
  });
}

describe("standalone HTTP core without Codex CLI", () => {
  test("startServer serves health identity, models, management, and one /v1/responses turn with no codex on PATH", async () => {
    let upstreamHits = 0;
    upstream = mockResponsesUpstream(() => {
      upstreamHits += 1;
    });

    const config: OcxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "mock",
      providers: {
        mock: {
          adapter: "openai-responses",
          baseUrl: `${upstream.url.origin}/v1`,
          apiKey: "standalone-test-key",
          allowPrivateNetwork: true,
        },
      },
    } as OcxConfig;
    saveConfig(config);

    const server = startServer(0);
    try {
      const health = await fetch(new URL("/healthz", server.url));
      expect(health.status).toBe(200);
      const healthBody = (await health.json()) as {
        status: string;
        service: string;
        pid: number;
        port: number;
        version: string;
        gitSha: string | null;
      };
      expect(healthBody.status).toBe("ok");
      expect(healthBody.service).toBe("opencodex");
      expect(typeof healthBody.pid).toBe("number");
      expect(typeof healthBody.port).toBe("number");
      expect(typeof healthBody.version).toBe("string");
      expect(healthBody.version.length).toBeGreaterThan(0);
      // Contract is string | null. This worktree has .git, so HEAD must resolve.
      expect(
        healthBody.gitSha === null || typeof healthBody.gitSha === "string",
      ).toBe(true);
      expect(typeof healthBody.gitSha).toBe("string");
      expect(healthBody.gitSha).toMatch(/^[0-9a-f]{7,40}$/i);

      const models = await fetch(new URL("/v1/models", server.url));
      expect(models.status).toBe(200);

      const providers = await fetch(new URL("/api/providers", server.url));
      expect(providers.status).toBeLessThan(500);

      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "mock/test-model",
          stream: false,
          input: "hello standalone",
        }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        status?: string;
        output?: unknown[];
      };
      expect(body.status).toBe("completed");
      expect(upstreamHits).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});
