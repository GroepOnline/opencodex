import type { PostHog } from "posthog-js";
import { sanitizedCurrentUrl, sanitizedUrlString } from "./posthog-sanitize";

export { sanitizedCurrentUrl } from "./posthog-sanitize";

const DEFAULT_HOST = "https://eu.i.posthog.com";

let client: PostHog | null = null;

function posthogKey(): string | undefined {
  const key = import.meta.env.VITE_POSTHOG_KEY;
  return typeof key === "string" && key.trim() ? key.trim() : undefined;
}

/** Shared localStorage key for the GUI telemetry preference. */
export const POSTHOG_PREFERENCE_KEY = "ocx-posthog";

/** Explicit preference values; null means unset (browser DNT decides). */
export type PostHogPreference = "0" | "1" | null;

/** Explicit opt-out (`localStorage ocx-posthog=0`) or browser DNT blocks init. */
export function isPostHogTelemetryAllowed(
  storage: Pick<Storage, "getItem"> | null | undefined,
  dnt: string | null | undefined,
): boolean {
  try {
    if (storage?.getItem(POSTHOG_PREFERENCE_KEY) === "0") return false;
  } catch {
    /* private mode / blocked storage — fall through to DNT */
  }
  return dnt !== "1";
}

/** Current preference: "0" (off), "1" (on), or null (unset — DNT decides). */
export function readPostHogPreference(
  storage: Pick<Storage, "getItem"> | null | undefined,
): PostHogPreference {
  try {
    const value = storage?.getItem(POSTHOG_PREFERENCE_KEY);
    return value === "0" || value === "1" ? value : null;
  } catch {
    return null;
  }
}

export function writePostHogPreference(
  storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined,
  value: PostHogPreference,
): void {
  if (!storage) return;
  try {
    if (value === null) storage.removeItem(POSTHOG_PREFERENCE_KEY);
    else storage.setItem(POSTHOG_PREFERENCE_KEY, value);
  } catch {
    /* private mode / blocked storage — preference cannot persist */
  }
}

function telemetryAllowed(): boolean {
  const dnt =
    navigator.doNotTrack ??
    (navigator as Navigator & { msDoNotTrack?: string }).msDoNotTrack;
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

/**
 * Disable an already-initialized client after the user turns telemetry off.
 * PostHog keeps queueing otherwise; opt_out() flushes nothing and drops
 * future captures, and shutdown() stops the retry loop. Called with the raw
 * posthog-js module to stay out of the import cycle.
 */
export function disablePostHogClient(posthogModule: {
  default: { opt_out: () => void };
}): void {
  try {
    posthogModule.default.opt_out();
  } catch {
    /* best-effort only */
  }
  client = null;
}
