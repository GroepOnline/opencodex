import type { PostHog } from "posthog-js";
import { sanitizedCurrentUrl, sanitizedUrlString } from "./posthog-sanitize";

export { sanitizedCurrentUrl } from "./posthog-sanitize";

const DEFAULT_HOST = "https://eu.i.posthog.com";

let client: PostHog | null = null;

function posthogKey(): string | undefined {
  const key = import.meta.env.VITE_POSTHOG_KEY;
  return typeof key === "string" && key.trim() ? key.trim() : undefined;
}

/** Explicit opt-out (`localStorage ocx-posthog=0`) or browser DNT blocks init. */
export function isPostHogTelemetryAllowed(
  storage: Pick<Storage, "getItem"> | null | undefined,
  dnt: string | null | undefined,
): boolean {
  try {
    if (storage?.getItem("ocx-posthog") === "0") return false;
  } catch {
    /* private mode / blocked storage — fall through to DNT */
  }
  return dnt !== "1";
}

function telemetryAllowed(): boolean {
  const dnt = navigator.doNotTrack ?? (navigator as Navigator & { msDoNotTrack?: string }).msDoNotTrack;
  try {
    return isPostHogTelemetryAllowed(localStorage, dnt);
  } catch {
    return isPostHogTelemetryAllowed(undefined, dnt);
  }
}

/** Init PostHog only when VITE_POSTHOG_KEY is set and telemetry is allowed. No identify / no PII. */
export function initPostHog(): void {
  const key = posthogKey();
  if (!key || typeof window === "undefined" || !telemetryAllowed()) {
    return;
  }

  const host =
    typeof import.meta.env.VITE_POSTHOG_HOST === "string" &&
    import.meta.env.VITE_POSTHOG_HOST.trim()
      ? import.meta.env.VITE_POSTHOG_HOST.trim()
      : DEFAULT_HOST;

  // Dynamic import: keyless deployments never fetch or evaluate the SDK chunk.
  void import("posthog-js").then(({ default: posthog }) => {
    client = posthog.init(key, {
      api_host: host,
      capture_pageview: false,
      capture_pageleave: true,
      persistence: "localStorage",
      person_profiles: "identified_only",
      // Strip hashes from every SDK-derived URL (autocapture, $pageleave,
      // campaign/session-entry props, replay). Explicit $current_url values,
      // like the allowlisted manual $pageview below, are unaffected.
      disable_capture_url_hashes: true,
      // Allowlist $current_url on every event (autocapture, $pageleave, ...),
      // not just the manual $pageview below, so hashes/queries never leak.
      sanitize_properties: (properties) => {
        if (typeof properties.$current_url === "string") {
          properties.$current_url = sanitizedUrlString(properties.$current_url);
        }
        return properties;
      },
    });

    captureHashPageview();
    window.addEventListener("hashchange", captureHashPageview);
  });
}

/** Manual $pageview for hash routes (e.g. #providers). */
export function captureHashPageview(): void {
  if (!client?.__loaded) {
    return;
  }

  client.capture("$pageview", {
    $current_url: sanitizedCurrentUrl(window.location),
  });
}
