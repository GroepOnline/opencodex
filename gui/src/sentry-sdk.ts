import * as Sentry from "@sentry/react";
import { sanitizeSentryEnvelope, sanitizeSentryEvent, sentrySettings } from "./sentry";

let enabled = false;

/** Synchronous and optional: initialized before React renders; no replay or request instrumentation. */
export function initSentry(): void {
  const settings = sentrySettings({
    VITE_SENTRY_DSN: import.meta.env.VITE_SENTRY_DSN,
    VITE_SENTRY_ENVIRONMENT: import.meta.env.VITE_SENTRY_ENVIRONMENT,
    VITE_SENTRY_RELEASE: import.meta.env.VITE_SENTRY_RELEASE,
  });
  if (!settings || enabled) return;
  try {
    Sentry.init({
      ...settings,
      sendDefaultPii: false,
      defaultIntegrations: false,
      integrations: [Sentry.globalHandlersIntegration()],
      sendClientReports: false,
      maxBreadcrumbs: 0,
      tracesSampleRate: 0,
      tracePropagationTargets: [],
      beforeBreadcrumb: () => null,
      beforeSend: (event) => sanitizeSentryEvent(event, settings),
      beforeSendTransaction: () => null,
      transport: (options) => {
        const transport = Sentry.makeFetchTransport({ ...options, fetchOptions: { credentials: "omit", referrerPolicy: "no-referrer" } });
        return {
          flush: (timeout) => transport.flush(timeout),
          send: (envelope) => {
            const safe = sanitizeSentryEnvelope(envelope, settings);
            return safe ? transport.send(safe) : Promise.resolve({});
          },
        };
      },
    });
    enabled = true;
  } catch {
    // Optional telemetry must not prevent rendering when configuration/SDK fails.
    enabled = false;
  }
}

export function captureReactError(error: unknown): void {
  if (!enabled) return;
  try {
    Sentry.captureException(error);
  } catch {
    // Capturing must not change React's error handling.
    return;
  }
}
