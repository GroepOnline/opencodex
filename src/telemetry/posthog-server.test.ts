import { describe, expect, test } from "bun:test";
import { aiGenerationProperties } from "./posthog-server";

describe("aiGenerationProperties", () => {
  test("emits canonical privacy-safe PostHog AI metadata", () => {
    const props = aiGenerationProperties({
      requestId: "req-1",
      provider: "openai",
      model: "gpt-4o-mini",
      status: 200,
      durationMs: 1500,
      firstOutputMs: 250,
      usageStatus: "reported",
      usage: { inputTokens: 100, outputTokens: 20 },
      conversationId: "0123456789abcdef0123456789abcdef",
      surface: "codex",
    }, "trace-1");

    expect(props.$ai_trace_id).toBe("trace-1");
    expect(props.$ai_generation_id).toBe("req-1");
    expect(props.$ai_session_id).toBe("0123456789abcdef0123456789abcdef");
    expect(props.$ai_model).toBe("gpt-4o-mini");
    expect(props.$ai_provider).toBe("openai");
    expect(props.$ai_latency).toBe(1.5);
    expect(props.$ai_time_to_first_token).toBe(0.25);
    expect(props.$ai_input_tokens).toBe(100);
    expect(props.$ai_output_tokens).toBe(20);
    expect(props.$ai_http_status).toBe(200);
    expect(props.$ai_is_error).toBe(false);
    expect(props).not.toHaveProperty("$ai_input");
    expect(props).not.toHaveProperty("$ai_output_choices");
  });

  test("uses requested service tier before configured tier for canonical cost", () => {
    const common = {
      requestId: "req-tier",
      provider: "openai",
      model: "gpt-5.6-sol",
      status: 200,
      durationMs: 100,
      usageStatus: "reported" as const,
      usage: { inputTokens: 1_000_000, outputTokens: 100_000 },
      requestedServiceTier: "default",
    };
    const requestedOnly = aiGenerationProperties(common, "trace-tier-base");
    const conflicting = aiGenerationProperties(
      { ...common, configuredServiceTier: "priority" },
      "trace-tier-conflict",
    );

    expect(requestedOnly.$ai_total_cost_usd).toBeDefined();
    expect(conflicting.$ai_total_cost_usd).toBe(requestedOnly.$ai_total_cost_usd);
  });

  test("reports normalized error code without accepting raw error content", () => {
    const props = aiGenerationProperties({
      requestId: "req-2",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      status: 429,
      durationMs: 50,
      errorCode: "rate_limit_exceeded",
      usageStatus: "unreported",
    }, "trace-2");

    expect(props.$ai_is_error).toBe(true);
    expect(props.$ai_error).toBe("rate_limit_exceeded");
    expect(props.$ai_latency).toBe(0.05);
  });
});
