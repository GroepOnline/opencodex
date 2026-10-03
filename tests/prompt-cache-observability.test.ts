import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResponsesPassthroughAdapter } from "../src/adapters/openai-responses";
import {
  normalizePromptCacheRequestObservation,
  observeOpenAiResponsesPromptCache,
} from "../src/prompt-cache/observability";
import {
  addFinalRequestLog,
  clearRequestLogsForTests,
  recordAdapterRequestMetadata,
  type RequestLogContext,
} from "../src/server/request-log";
import {
  readUsageEntries,
  resetUsageReadCacheForTests,
  usageLogPath,
} from "../src/usage/log";
import type { OcxProviderConfig } from "../src/types";

describe("prompt cache observability", () => {
  test("captures structural cache dimensions without retaining request content", () => {
    const observation = observeOpenAiResponsesPromptCache({
      model: "gpt-5.6-terra",
      instructions: "private instruction marker",
      prompt_cache_key: "private-cache-key",
      prompt_cache_options: {
        mode: "implicit",
        ttl: "30m",
        prewarm: true,
        comparison_response_id: "resp_private",
      },
      previous_response_id: "resp_previous",
      text: {
        verbosity: "medium",
        format: { type: "json_schema", name: "private-format" },
      },
      tools: [{
        type: "function",
        name: "lookup_private_tool",
        parameters: { type: "object", properties: { secret: { type: "string" } } },
      }],
      input: [{
        role: "developer",
        content: [{
          type: "input_text",
          text: "private developer prefix",
          prompt_cache_breakpoint: { mode: "explicit" },
        }],
      }, {
        role: "user",
        content: [{ type: "input_text", text: "private user content" }],
      }],
    });

    expect(observation).toMatchObject({
      version: 1,
      keyPresent: true,
      mode: "implicit",
      ttl: "30m",
      prewarm: true,
      comparisonRequested: true,
      previousResponseIdPresent: true,
      breakpointCount: 1,
      inputItemCount: 2,
      toolCount: 1,
      verbosity: "medium",
    });
    expect(observation?.toolsFingerprint).toMatch(/^[0-9a-f]{24}$/);
    expect(observation?.stablePrefixFingerprint).toMatch(/^[0-9a-f]{24}$/);
    expect(observation?.textFormatFingerprint).toMatch(/^[0-9a-f]{24}$/);
    const serialized = JSON.stringify(observation);
    expect(serialized).not.toContain("private-cache-key");
    expect(serialized).not.toContain("private instruction marker");
    expect(serialized).not.toContain("private developer prefix");
    expect(serialized).not.toContain("private user content");
    expect(serialized).not.toContain("lookup_private_tool");
    expect(serialized).not.toContain("private-format");
  });

  test("fingerprints are stable for object-key order but preserve tool array order", () => {
    const a = observeOpenAiResponsesPromptCache({
      instructions: "stable",
      tools: [
        { type: "function", name: "a", parameters: { type: "object", properties: { x: { type: "string" } } } },
        { type: "function", name: "b", parameters: { type: "object" } },
      ],
    });
    const same = observeOpenAiResponsesPromptCache({
      tools: [
        { name: "a", parameters: { properties: { x: { type: "string" } }, type: "object" }, type: "function" },
        { parameters: { type: "object" }, name: "b", type: "function" },
      ],
      instructions: "stable",
    });
    const reordered = observeOpenAiResponsesPromptCache({
      instructions: "stable",
      tools: [
        { type: "function", name: "b", parameters: { type: "object" } },
        { type: "function", name: "a", parameters: { type: "object", properties: { x: { type: "string" } } } },
      ],
    });

    expect(a?.toolsFingerprint).toBe(same?.toolsFingerprint);
    expect(a?.stablePrefixFingerprint).toBe(same?.stablePrefixFingerprint);
    expect(a?.toolsFingerprint).not.toBe(reordered?.toolsFingerprint);
  });

  test("preserves __proto__ as ordinary schema data when fingerprinting", () => {
    const firstTool: unknown = JSON.parse(
      '{"type":"function","name":"x","parameters":{"type":"object","properties":{"__proto__":{"const":"a"}}}}',
    );
    const secondTool: unknown = JSON.parse(
      '{"type":"function","name":"x","parameters":{"type":"object","properties":{"__proto__":{"const":"b"}}}}',
    );

    const first = observeOpenAiResponsesPromptCache({ tools: [firstTool] });
    const second = observeOpenAiResponsesPromptCache({ tools: [secondTool] });

    expect(first?.toolsFingerprint).toMatch(/^[0-9a-f]{24}$/);
    expect(second?.toolsFingerprint).toMatch(/^[0-9a-f]{24}$/);
    expect(first?.toolsFingerprint).not.toBe(second?.toolsFingerprint);
  });

  test("normalizer accepts generated observations and rejects malformed persisted data", () => {
    const observation = observeOpenAiResponsesPromptCache({
      prompt_cache_options: { mode: "explicit", ttl: "30m" },
      input: [{ content: [{ prompt_cache_breakpoint: { mode: "explicit" } }] }],
    });
    expect(normalizePromptCacheRequestObservation(observation)).toEqual(observation);
    expect(normalizePromptCacheRequestObservation({
      ...observation,
      breakpointCount: -1,
    })).toBeUndefined();
    expect(normalizePromptCacheRequestObservation({
      version: 1,
      keyPresent: true,
      mode: "invalid",
      prewarm: false,
      comparisonRequested: false,
      previousResponseIdPresent: false,
      breakpointCount: 0,
      inputItemCount: 0,
      toolCount: 0,
    })).toBeUndefined();
  });

  test("flows the final outbound observation through request logging into usage.jsonl", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-cache-observation-"));
    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = dir;
    resetUsageReadCacheForTests();
    clearRequestLogsForTests();

    try {
      const provider: OcxProviderConfig = {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authMode: "key",
        apiKey: "test-key",
      };
      const adapter = createResponsesPassthroughAdapter(provider);
      const request = adapter.buildRequest({
        modelId: "gpt-5.6-terra",
        context: { messages: [] },
        stream: true,
        options: { promptCacheKey: "private-cache-key" },
        _rawBody: {
          model: "gpt-5.6-terra",
          instructions: "private fixed prefix",
          input: [{ role: "user", content: "hello" }],
          tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
          prompt_cache_key: "private-cache-key",
          prompt_cache_options: { mode: "implicit", ttl: "30m" },
        },
      });
      const logCtx: RequestLogContext = {
        model: "gpt-5.6-terra",
        provider: "openai-apikey",
        providerAdapter: adapter.name,
        usage: {
          inputTokens: 100,
          outputTokens: 5,
          cacheReadInputTokens: 80,
        },
      };
      recordAdapterRequestMetadata(logCtx, request);
      addFinalRequestLog("ocx-cache-e2e", 1_000, logCtx, 200);

      const entries = readUsageEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        requestId: "ocx-cache-e2e",
        adapter: "openai-responses",
        usageStatus: "reported",
        usage: { inputTokens: 100, cacheReadInputTokens: 80 },
        promptCache: {
          version: 1,
          keyPresent: true,
          mode: "implicit",
          ttl: "30m",
          toolCount: 1,
        },
      });
      const persisted = readFileSync(usageLogPath(), "utf8");
      expect(persisted).not.toContain("private-cache-key");
      expect(persisted).not.toContain("private fixed prefix");
      expect(persisted).not.toContain("\"shell\"");
    } finally {
      clearRequestLogsForTests();
      resetUsageReadCacheForTests();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
