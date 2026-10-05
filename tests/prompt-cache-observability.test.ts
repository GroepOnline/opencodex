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
      tools: [
        {
          type: "function",
          name: "lookup_private_tool",
          parameters: {
            type: "object",
            properties: { secret: { type: "string" } },
          },
        },
      ],
      input: [
        {
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "private developer prefix",
              prompt_cache_breakpoint: { mode: "explicit" },
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: "private user content" }],
        },
      ],
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

  test("only persists supported Responses verbosity values", () => {
    expect(
      observeOpenAiResponsesPromptCache({
        text: { verbosity: "low" },
      })?.verbosity,
    ).toBe("low");
    expect(
      observeOpenAiResponsesPromptCache({
        text: { verbosity: "medium" },
      })?.verbosity,
    ).toBe("medium");
    expect(
      observeOpenAiResponsesPromptCache({
        text: { verbosity: "high" },
      })?.verbosity,
    ).toBe("high");

    const unsupported = observeOpenAiResponsesPromptCache({
      text: { verbosity: "private caller-controlled marker" },
    });
    expect(unsupported).not.toHaveProperty("verbosity");
    expect(
      normalizePromptCacheRequestObservation({
        ...unsupported,
        verbosity: "private persisted marker",
      }),
    ).not.toHaveProperty("verbosity");
  });

  test("fingerprints are stable for object-key order but preserve tool array order", () => {
    const a = observeOpenAiResponsesPromptCache({
      instructions: "stable",
      tools: [
        {
          type: "function",
          name: "a",
          parameters: { type: "object", properties: { x: { type: "string" } } },
        },
        { type: "function", name: "b", parameters: { type: "object" } },
      ],
    });
    const same = observeOpenAiResponsesPromptCache({
      tools: [
        {
          name: "a",
          parameters: { properties: { x: { type: "string" } }, type: "object" },
          type: "function",
        },
        { parameters: { type: "object" }, name: "b", type: "function" },
      ],
      instructions: "stable",
    });
    const reordered = observeOpenAiResponsesPromptCache({
      instructions: "stable",
      tools: [
        { type: "function", name: "b", parameters: { type: "object" } },
        {
          type: "function",
          name: "a",
          parameters: { type: "object", properties: { x: { type: "string" } } },
        },
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
    expect(normalizePromptCacheRequestObservation(observation)).toEqual(
      observation,
    );
    expect(
      normalizePromptCacheRequestObservation({
        ...observation,
        breakpointCount: -1,
      }),
    ).toBeUndefined();
    expect(
      normalizePromptCacheRequestObservation({
        version: 1,
        keyPresent: true,
        mode: "invalid",
        prewarm: false,
        comparisonRequested: false,
        previousResponseIdPresent: false,
        breakpointCount: 0,
        inputItemCount: 0,
        toolCount: 0,
      }),
    ).toBeUndefined();
  });

  test.each(
    [undefined, null, [], "prompt", 42, true].map((value) => ({ value })),
  )("ignores non-object request and persisted values: $value", ({ value }) => {
    expect(observeOpenAiResponsesPromptCache(value)).toBeUndefined();
    expect(normalizePromptCacheRequestObservation(value)).toBeUndefined();
  });

  test("empty requests have only structural defaults", () => {
    expect(observeOpenAiResponsesPromptCache({})).toEqual({
      version: 1,
      mode: "default",
      keyPresent: false,
      prewarm: false,
      comparisonRequested: false,
      previousResponseIdPresent: false,
      breakpointCount: 0,
      inputItemCount: 0,
      toolCount: 0,
    });
  });

  test("does not coerce unsupported cache options or presence flags", () => {
    const observation = observeOpenAiResponsesPromptCache({
      prompt_cache_key: " \t",
      previous_response_id: 1,
      prompt_cache_retention: "forever",
      prompt_cache_options: {
        mode: "IMPLICIT",
        ttl: "60m",
        prewarm: "true",
        comparison_response_id: [],
      },
      tools: { name: "not-an-array" },
      text: { verbosity: "HIGH" },
    });
    expect(observation).toEqual(observeOpenAiResponsesPromptCache({}));
    expect(
      observeOpenAiResponsesPromptCache({ prompt_cache_options: [] }),
    ).toEqual(observeOpenAiResponsesPromptCache({}));
  });

  test.each(["in_memory", "24h"])(
    "preserves supported legacy retention %s",
    (retention) => {
      const observation = observeOpenAiResponsesPromptCache({
        prompt_cache_retention: retention,
      });
      expect(observation?.legacyRetention).toBe(retention);
      expect(normalizePromptCacheRequestObservation(observation)).toEqual(
        observation,
      );
    },
  );

  test.each([
    { input: undefined, count: 0 },
    { input: [], count: 0 },
    { input: "hello", count: 1 },
    { input: null, count: 1 },
    { input: [{ role: "user" }, { role: "assistant" }], count: 2 },
  ])("counts input items for $input", ({ input, count }) => {
    expect(observeOpenAiResponsesPromptCache({ input })?.inputItemCount).toBe(
      count,
    );
  });

  test("counts only explicit breakpoints within input, excluding breakpoint metadata", () => {
    const observation = observeOpenAiResponsesPromptCache({
      tools: [{ prompt_cache_breakpoint: { mode: "explicit" } }],
      input: [
        {
          prompt_cache_breakpoint: {
            mode: "explicit",
            metadata: { prompt_cache_breakpoint: { mode: "explicit" } },
          },
          content: [
            { prompt_cache_breakpoint: { mode: "explicit" } },
            { prompt_cache_breakpoint: { mode: "implicit" } },
            { prompt_cache_breakpoint: "explicit" },
            { prompt_cache_breakpoint: [{ mode: "explicit" }] },
            null,
            [{ nested: { prompt_cache_breakpoint: { mode: "explicit" } } }],
          ],
        },
      ],
    });
    expect(observation?.breakpointCount).toBe(3);
  });

  test("stable prefix ends at the first non-system/developer item", () => {
    const prefix = [
      { role: "system", content: "fixed system" },
      { role: "developer", content: "fixed developer" },
    ];
    const body = { instructions: "fixed instructions", input: prefix };
    const baseline =
      observeOpenAiResponsesPromptCache(body)?.stablePrefixFingerprint;
    expect(baseline).toMatch(/^[0-9a-f]{24}$/);
    for (const boundary of [
      { role: "user", content: "variable" },
      { type: "function_call" },
      null,
    ]) {
      expect(
        observeOpenAiResponsesPromptCache({
          ...body,
          input: [
            ...prefix,
            boundary,
            { role: "developer", content: "later instructions" },
          ],
        })?.stablePrefixFingerprint,
      ).toBe(baseline);
    }
    expect(
      observeOpenAiResponsesPromptCache({
        ...body,
        instructions: "changed instructions",
      })?.stablePrefixFingerprint,
    ).not.toBe(baseline);
    expect(
      observeOpenAiResponsesPromptCache({
        ...body,
        input: [...prefix].reverse(),
      })?.stablePrefixFingerprint,
    ).not.toBe(baseline);
    expect(
      observeOpenAiResponsesPromptCache({
        input: [{ role: "user", content: "hello" }, ...prefix],
      }),
    ).not.toHaveProperty("stablePrefixFingerprint");
  });

  test("format fingerprints ignore object-key order but retain nested array order and values", () => {
    const fingerprint = (format: unknown) =>
      observeOpenAiResponsesPromptCache({ text: { format } })
        ?.textFormatFingerprint;
    const first = fingerprint({
      type: "json_schema",
      schema: { enum: ["a", "b"], title: "result" },
    });
    expect(first).toMatch(/^[0-9a-f]{24}$/);
    expect(
      fingerprint({
        schema: { title: "result", enum: ["a", "b"] },
        type: "json_schema",
      }),
    ).toBe(first);
    expect(
      fingerprint({
        type: "json_schema",
        schema: { enum: ["b", "a"], title: "result" },
      }),
    ).not.toBe(first);
    expect(
      fingerprint({
        type: "json_schema",
        schema: { enum: ["a", "c"], title: "result" },
      }),
    ).not.toBe(first);
  });

  for (const field of [
    "breakpointCount",
    "inputItemCount",
    "toolCount",
  ] as const) {
    test.each([-1, 0.5, 1_000_001, NaN, Infinity, "1", null, undefined])(
      `rejects invalid persisted ${field}: %j`,
      (value) => {
        expect(
          normalizePromptCacheRequestObservation({
            ...observeOpenAiResponsesPromptCache({}),
            [field]: value,
          }),
        ).toBeUndefined();
      },
    );
    test.each([0, 1_000_000])(
      `accepts persisted ${field} boundary %i`,
      (value) => {
        const observation = {
          ...observeOpenAiResponsesPromptCache({}),
          [field]: value,
        };
        expect(normalizePromptCacheRequestObservation(observation)).toEqual(
          observation,
        );
      },
    );
  }

  for (const field of [
    "keyPresent",
    "prewarm",
    "comparisonRequested",
    "previousResponseIdPresent",
  ]) {
    test.each([undefined, null, 0, "false"])(
      `rejects non-boolean ${field}: %j`,
      (value) => {
        expect(
          normalizePromptCacheRequestObservation({
            ...observeOpenAiResponsesPromptCache({}),
            [field]: value,
          }),
        ).toBeUndefined();
      },
    );
  }

  test.each([undefined, 0, 2, "1"])(
    "rejects unsupported persisted version %j",
    (version) => {
      expect(
        normalizePromptCacheRequestObservation({
          ...observeOpenAiResponsesPromptCache({}),
          version,
        }),
      ).toBeUndefined();
    },
  );

  test("normalization strips unknown fields and invalid optional metadata without losing the core", () => {
    const core = observeOpenAiResponsesPromptCache({});
    for (const invalid of [
      "a".repeat(23),
      "a".repeat(25),
      "A".repeat(24),
      "g".repeat(24),
      123,
      null,
    ]) {
      expect(
        normalizePromptCacheRequestObservation({
          ...core,
          toolsFingerprint: invalid,
          stablePrefixFingerprint: invalid,
          textFormatFingerprint: invalid,
          ttl: "24h",
          legacyRetention: "forever",
          verbosity: "private verbosity",
          prompt_cache_key: "private key",
          instructions: "private text",
        }),
      ).toEqual(core);
    }
    const valid = {
      ...core,
      toolsFingerprint: "a".repeat(24),
      stablePrefixFingerprint: "0".repeat(24),
      textFormatFingerprint: "0123456789abcdef01234567",
    };
    const normalized = normalizePromptCacheRequestObservation(valid);
    expect(normalized).toEqual(valid);
    expect(normalized).not.toBe(valid);
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
          tools: [
            { type: "function", name: "shell", parameters: { type: "object" } },
          ],
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
      expect(persisted).not.toContain('"shell"');
    } finally {
      clearRequestLogsForTests();
      resetUsageReadCacheForTests();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
