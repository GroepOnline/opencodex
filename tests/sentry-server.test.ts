import { describe, expect, test } from "bun:test";
import { sanitizeSentryEnvelope, sanitizeSentryEvent, sentryEventFromError } from "../src/telemetry/sentry-privacy";
import { createServerSentry, sentryServerSettings } from "../src/telemetry/sentry-server";

const SECRET = ["provider", "secret", "value"].join("-");
const DSN = ["https://public", "example.invalid/1"].join("@");

describe("server Sentry privacy boundary", () => {
  test("configuration is opt-in and rejects malformed DSNs", () => {
    expect(sentryServerSettings({})).toBeUndefined();
    expect(sentryServerSettings({ SENTRY_DSN: "not-a-url" })).toBeUndefined();
    expect(sentryServerSettings({ SENTRY_DSN: DSN, SENTRY_ENVIRONMENT: "production", SENTRY_RELEASE: "1.4.2" }))
      .toEqual({ dsn: DSN, environment: "production", release: "1.4.2" });
  });

  test("raw exception text, paths, context and arbitrary fields never survive", () => {
    const safe = sanitizeSentryEvent({
      event_id: "a".repeat(32),
      message: SECRET,
      request: { url: `https://private.example/?token=${SECRET}` },
      contexts: { trace: { data: { prompt: SECRET } } },
      breadcrumbs: [{ message: SECRET }],
      extra: { output: SECRET },
      exception: { values: [{
        type: "TypeError", value: SECRET,
        stacktrace: { frames: [{ filename: `/private-root/${SECRET}.ts`, function: SECRET, lineno: 12, colno: 4 }] },
      }] },
    }, { environment: "production", release: "1.4.2" });
    const serialized = JSON.stringify(safe);
    expect(safe?.exception.values[0].type).toBe("TypeError");
    expect(safe?.exception.values[0].value).toBe("Unexpected failure");
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("/private-root");
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("output");
  });

  test("capture rebuilds Error and init disables tracing/integrations", () => {
    type SentrySdk = ReturnType<Parameters<typeof createServerSentry>[0]>;
    type InitOptions = Parameters<SentrySdk["init"]>[0];
    type CapturedEvent = Parameters<SentrySdk["captureEvent"]>[0];
    let options: InitOptions | undefined;
    const captured: CapturedEvent[] = [];
    const fake: SentrySdk = {
      init(value) { options = value; },
      captureEvent(value) { captured.push(value); },
      close: async () => true,
      makeFetchTransport: (() => ({ send: async () => ({}), flush: async () => true })) as SentrySdk["makeFetchTransport"],
    };
    const telemetry = createServerSentry(() => fake);
    telemetry.init({ SENTRY_DSN: DSN, SENTRY_ENVIRONMENT: "production", SENTRY_RELEASE: "1.4.2" });
    expect(options).toBeDefined();
    const initialized = options!;
    expect(initialized.defaultIntegrations).toBe(false);
    expect(initialized.integrations).toEqual([]);
    expect(initialized.sendDefaultPii).toBe(false);
    expect(initialized.tracesSampleRate).toBe(0);
    expect(initialized.skipOpenTelemetrySetup).toBe(true);
    expect(initialized.beforeSendTransaction?.({ name: SECRET } as never, {} as never)).toBeNull();
    expect(sanitizeSentryEnvelope([{}, [[{ type: "span" }, { op: "gen_ai.invoke_agent", data: { "gen_ai.request.messages": SECRET } }]]], {})).toEqual([]);
    telemetry.capture(new TypeError(SECRET));
    expect(captured).toHaveLength(1);
    expect(JSON.stringify(captured[0])).not.toContain(SECRET);
  });

  test("non-Error thrown values are reduced to a generic error", () => {
    const safe = sanitizeSentryEvent(sentryEventFromError({ prompt: SECRET }));
    expect(safe?.exception.values[0].type).toBe("Error");
    expect(JSON.stringify(safe)).not.toContain(SECRET);
  });
});
