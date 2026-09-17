import type { BunOptions, Event } from "@sentry/bun";
import { safeSentryMetadata, sanitizeSentryEnvelope, sanitizeSentryEvent, sentryEventFromError } from "./sentry-privacy";

interface SentrySdk {
  init(options: BunOptions): unknown;
  captureEvent(event: Event): unknown;
  close(timeout: number): PromiseLike<boolean>;
  makeFetchTransport: NonNullable<BunOptions["transport"]>;
}

type Environment = Record<string, string | undefined>;
export const SENTRY_SHUTDOWN_TIMEOUT_MS = 200;

export function sentryServerSettings(env: Environment) {
  const dsn = env.OCX_SENTRY_DSN?.trim() || env.SENTRY_DSN?.trim();
  if (!dsn) return undefined;
  try {
    const url = new URL(dsn);
    if (!/^https?:$/.test(url.protocol) || !url.username || url.password || url.search || url.hash) return undefined;
  } catch {
    return undefined;
  }
  return {
    dsn,
    ...safeSentryMetadata(
      env.OCX_SENTRY_ENVIRONMENT || env.SENTRY_ENVIRONMENT,
      env.OCX_SENTRY_RELEASE || env.SENTRY_RELEASE,
    ),
  };
}

/** A private lifecycle avoids process handlers and preserves the daemon's crash guards. */
export function createServerSentry(loadSdk: () => SentrySdk) {
  let sdk: SentrySdk | undefined;
  let attempted = false;
  let closing: Promise<void> | undefined;
  let metadata = safeSentryMetadata();
  return {
    init(env: Environment = process.env): void {
      if (attempted) return;
      const settings = sentryServerSettings(env);
      if (!settings) return;
      attempted = true;
      metadata = safeSentryMetadata(settings.environment, settings.release);
      try {
        const loaded = loadSdk();
        loaded.init({
          ...settings,
          defaultIntegrations: false,
          integrations: [],
          sendDefaultPii: false,
          sendClientReports: false,
          enableLogs: false,
          // No automatic request instrumentation or trace propagation in a credential proxy.
          tracesSampleRate: 0,
          tracePropagationTargets: [],
          skipOpenTelemetrySetup: true,
          serverName: "opencodex",
          maxBreadcrumbs: 0,
          beforeBreadcrumb: () => null,
          beforeSend: event => sanitizeSentryEvent(event, metadata),
          beforeSendTransaction: () => null,
          transport: options => {
            const transport = loaded.makeFetchTransport(options);
            return {
              flush: timeout => transport.flush(timeout),
              send: async envelope => {
                try {
                  const events = sanitizeSentryEnvelope(envelope, metadata);
                  for (const event of events) {
                    if (!event.event_id) continue;
                    await transport.send([{ sent_at: new Date().toISOString(), event_id: event.event_id }, [[{ type: "event" }, event]]]);
                  }
                } catch {
                  // Fail closed; SDK/transport failures never enter the daemon crash guard.
                  return {};
                }
                return {};
              },
            };
          },
        });
        sdk = loaded;
      } catch {
        // Optional telemetry cannot prevent a proxy from starting, including a missing SDK.
        sdk = undefined;
      }
    },
    capture(error: unknown): void {
      if (!sdk) return;
      try {
        const event = sanitizeSentryEvent(sentryEventFromError(error), metadata);
        if (event) sdk.captureEvent(event);
      } catch {
        // Error accessors and SDK failures are untrusted too; drop the event.
        return;
      }
    },
    close(): Promise<void> {
      if (closing) return closing;
      const active = sdk;
      sdk = undefined;
      if (!active) return Promise.resolve();
      closing = new Promise<void>(resolve => {
        const timer = setTimeout(resolve, SENTRY_SHUTDOWN_TIMEOUT_MS);
        const finish = () => { clearTimeout(timer); resolve(); };
        try {
          // Independent deadline: even a broken SDK ignoring its own timeout cannot block exit.
          Promise.resolve(active.close(SENTRY_SHUTDOWN_TIMEOUT_MS)).then(finish, finish);
        } catch {
          finish();
        }
      });
      return closing;
    },
  };
}

// Bun's synchronous require keeps startServer synchronous and avoids loading Sentry without a DSN.
const telemetry = createServerSentry(() => require("@sentry/bun"));
export const initServerSentry = telemetry.init;
export const captureServerFailure = telemetry.capture;
export const closeServerSentry = telemetry.close;
