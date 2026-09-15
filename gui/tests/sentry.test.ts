import { describe, expect, test } from "bun:test";
import { sanitizeSentryEnvelope, sanitizeSentryEvent, sentrySettings } from "../src/sentry";

const secret = "sk-provider-secret";
const event = {
  event_id: "a".repeat(32),
  request: { url: `https://private.example/?key=${secret}`, headers: { Authorization: secret }, data: secret },
  user: { email: "private@example.com" },
  breadcrumbs: [{ message: secret }],
  contexts: { trace: { data: { prompt: secret } } },
  extra: { output: secret, tool: { payload: secret } },
  message: secret,
  tags: { secret },
  exception: { values: [{
    type: "TypeError", value: secret,
    mechanism: { data: { secret } },
    stacktrace: { frames: [
      { filename: `/private-root/${secret}.ts`, abs_path: `/private-root/${secret}.ts`, function: secret, module: secret, vars: { secret }, pre_context: [secret], lineno: 12, colno: 7 },
      { filename: `C:\\private-root\\${secret}.tsx`, lineno: 8 },
      { filename: `https://private.example/assets/${secret}.js?key=${secret}#${secret}`, lineno: 42 },
      { filename: `file:///private-root/${secret}.ts` },
    ] },
  }] },
};

describe("optional GUI Sentry", () => {
  test("env gating and explicit metadata allowlists", () => {
    expect(sentrySettings({})).toBeUndefined();
    expect(sentrySettings({ VITE_SENTRY_DSN: "  " })).toBeUndefined();
    expect(sentrySettings({ VITE_SENTRY_DSN: " dsn ", VITE_SENTRY_RELEASE: "1.4.2", VITE_SENTRY_ENVIRONMENT: "production" }))
      .toEqual({ dsn: "dsn", release: "1.4.2", environment: "production" });
    expect(sentrySettings({ VITE_SENTRY_DSN: "dsn", VITE_SENTRY_RELEASE: secret, VITE_SENTRY_ENVIRONMENT: "/home/private" }))
      .toEqual({ dsn: "dsn", release: undefined, environment: undefined });
  });

  test("retains exception type and safe stack coordinates only", () => {
    const safe = sanitizeSentryEvent(event);
    expect(safe?.exception.values[0].type).toBe("TypeError");
    expect(safe?.exception.values[0].stacktrace?.frames).toEqual([
      { filename: "app:///gui", lineno: 12, colno: 7 },
      { filename: "app:///gui", lineno: 8, colno: undefined },
      { filename: "app:///gui.js", lineno: 42, colno: undefined },
      { filename: "app:///gui", lineno: undefined, colno: undefined },
    ]);
    const serialized = JSON.stringify(safe);
    for (const privateValue of [secret, "private", "Authorization", "request", "breadcrumbs", "contexts", "extra", "/private-root/", "https://", "file://", "?"]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  test("custom exception types and malformed source coordinates cannot leak content", () => {
    const safe = sanitizeSentryEvent({ event_id: secret, exception: { values: [{ type: secret, stacktrace: { frames: [{ lineno: secret, colno: Infinity }] } }] } });
    expect(safe?.exception.values[0].type).toBe("Error");
    expect(JSON.stringify(safe)).not.toContain(secret);
    expect(safe?.event_id).toBeUndefined();
  });

  test("drops non-errors, transaction events, arbitrary objects and hostile getters", () => {
    expect(sanitizeSentryEvent({ type: "transaction", ...event })).toBeNull();
    expect(sanitizeSentryEvent({ message: secret })).toBeNull();
    expect(sanitizeSentryEvent({ get exception() { throw new Error(secret); } })).toBeNull();
  });

  test("transport removes envelope baggage, attachments, sessions, logs and client reports", () => {
    const safe = sanitizeSentryEnvelope([
      { trace: { baggage: secret }, dsn: secret, sdk: { name: secret } },
      [[{ type: "event", filename: secret }, event], ...["attachment", "session", "transaction", "span", "log", "client_report"].map((type) => [{ type }, secret])],
    ]);
    expect(safe?.[0].event_id).toBe("a".repeat(32));
    expect(safe?.[0].sent_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(safe?.[1]).toHaveLength(1);
    expect(safe?.[1][0][0]).toEqual({ type: "event" });
    expect(JSON.stringify(safe)).not.toContain(secret);
    expect(sanitizeSentryEnvelope([{}, [[{ type: "attachment" }, secret]]])).toBeNull();
  });
});
