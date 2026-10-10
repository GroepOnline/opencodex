import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import {
  buildDesktop3pRegistry,
  resetDesktop3pRegistryForTests,
  resolveDesktop3pAlias,
} from "../src/claude/desktop-3p";
import { startServer } from "../src/server";
import { managementFetch } from "./helpers/management-auth";
import {
  installIsolatedCodexHome,
  type IsolatedCodexHome,
} from "./helpers/isolated-codex-home";
import type { OcxClaudeDesktopProfile, OcxConfig } from "../src/types";

const route = "azure-foundry-joepgroep1/DeepSeek-V4-Pro";
const alias = "claude-opus-4-8-20260818";
const providerId = "azure-foundry-joepgroep1";
let testDir = "";
let priorHome: string | undefined;
let codex: IsolatedCodexHome | null = null;

beforeEach(() => {
  priorHome = process.env.OPENCODEX_HOME;
  codex = installIsolatedCodexHome("ocx-stale-desktop-route-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-stale-desktop-route-"));
  process.env.OPENCODEX_HOME = testDir;
  resetDesktop3pRegistryForTests();
});

afterEach(() => {
  resetDesktop3pRegistryForTests();
  if (priorHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = priorHome;
  codex?.restore();
  codex = null;
  rmSync(testDir, { recursive: true, force: true });
});

const profile: OcxClaudeDesktopProfile = {
  version: 1,
  assignments: { [route]: { family: "opus", alias } },
  defaults: { opus: route, fable: null, sonnet: null, haiku: null },
};

for (const state of ["removed", "disabled"] as const) {
  test(`Claude Desktop alias for ${state} provider never falls through to default Codex provider`, async () => {
    let upstreamCalls = 0;
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        upstreamCalls += 1;
        return Response.json(
          { error: { message: "wrong provider received request" } },
          { status: 400 },
        );
      },
    });
    const config: OcxConfig = {
      port: 0,
      defaultProvider: "mock",
      providers: {
        mock: {
          adapter: "openai-chat",
          baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`,
          apiKey: "fixture",
          allowPrivateNetwork: true,
        },
        ...(state === "disabled"
          ? {
              [providerId]: {
                adapter: "openai-chat" as const,
                baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`,
                apiKey: "fixture",
                allowPrivateNetwork: true,
                disabled: true,
              },
            }
          : {}),
      },
      claudeCode: { enabled: true, authMode: "proxy", desktopProfile: profile },
    } as OcxConfig;
    saveConfig(config);
    const server = startServer(0);
    try {
      buildDesktop3pRegistry(
        [],
        [{ provider: providerId, id: "DeepSeek-V4-Pro" }],
        profile,
      );
      expect(resolveDesktop3pAlias(alias)).toBe(route);
      const response = await managementFetch(
        new URL("/v1/messages", server.url),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": "placeholder",
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: alias,
            max_tokens: 16,
            messages: [{ role: "user", content: "Reply OK" }],
          }),
        },
      );
      const result = (await response.json()) as {
        error?: { message?: string };
      };
      expect(response.status).toBe(400);
      expect(result.error?.message).toContain("unavailable provider");
      expect(result.error?.message).toContain(providerId);
      expect(upstreamCalls).toBe(0);
    } finally {
      server.stop(true);
      upstream.stop(true);
    }
  });
}

test("Claude Desktop alias for configured virtual combo still reaches its selected provider", async () => {
  const comboRoute = "reasoning-toggle/gpt-5.5";
  const comboAlias = "claude-opus-4-8-20260909";
  const comboProfile: OcxClaudeDesktopProfile = {
    version: 1,
    assignments: { [comboRoute]: { family: "opus", alias: comboAlias } },
    defaults: { opus: comboRoute, fable: null, sonnet: null, haiku: null },
  };
  const captured: Array<Record<string, unknown>> = [];
  const upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      captured.push((await req.json()) as Record<string, unknown>);
      return new Response(
        [
          'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"OK"}}]}\n\n',
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":2}}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  saveConfig({
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: {
        adapter: "openai-chat",
        baseUrl: new URL("/v1", upstream.url).toString(),
        apiKey: "fixture",
        allowPrivateNetwork: true,
      },
    },
    combos: {
      "reasoning-test": {
        strategy: "failover",
        alias: comboRoute,
        targets: [{ provider: "mock", model: "test-model" }],
      },
    },
    claudeCode: {
      enabled: true,
      authMode: "proxy",
      desktopProfile: comboProfile,
    },
  } as OcxConfig);
  const server = startServer(0);
  try {
    buildDesktop3pRegistry(
      [],
      [{ provider: "reasoning-toggle", id: "gpt-5.5" }],
      comboProfile,
    );
    const response = await managementFetch(
      new URL("/v1/messages", server.url),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "placeholder",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: comboAlias,
          max_tokens: 16,
          messages: [{ role: "user", content: "Reply OK" }],
        }),
      },
    );
    const json = (await response.json()) as {
      type?: string;
      error?: { message?: string };
    };
    expect(response.status).toBe(200);
    expect(json.type).toBe("message");
    expect(captured.length).toBe(1);
    expect(captured[0]?.model).toBe("test-model");
  } finally {
    server.stop(true);
    upstream.stop(true);
  }
});


test("retired dated Desktop alias cannot fall through after profile resync", async () => {
  let upstreamCalls = 0;
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      upstreamCalls += 1;
      return Response.json({ error: { message: "wrong provider received retired alias" } }, { status: 400 });
    },
  });
  const currentProfile: OcxClaudeDesktopProfile = {
    version: 1,
    assignments: {
      "native/gpt-5.6-sol": { family: "opus", alias: "claude-opus-4-8-20261001" },
    },
    defaults: {
      opus: "native/gpt-5.6-sol",
      fable: null,
      sonnet: null,
      haiku: null,
    },
  };
  saveConfig({
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: {
        adapter: "openai-chat",
        baseUrl: new URL("/v1", upstream.url).toString(),
        apiKey: "fixture",
        allowPrivateNetwork: true,
      },
    },
    claudeCode: { enabled: true, authMode: "proxy", desktopProfile: currentProfile },
  } as OcxConfig);
  const server = startServer(0);
  try {
    buildDesktop3pRegistry(["gpt-5.6-sol"], [], currentProfile);
    expect(resolveDesktop3pAlias(alias)).toBeNull();
    const response = await managementFetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "placeholder",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: alias,
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply OK" }],
      }),
    });
    const result = (await response.json()) as { error?: { message?: string } };
    expect(response.status).toBe(400);
    expect(result.error?.message).toContain("no longer present");
    expect(upstreamCalls).toBe(0);
  } finally {
    server.stop(true);
    upstream.stop(true);
  }
});
