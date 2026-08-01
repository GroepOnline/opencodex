import posthog from "posthog-js";
import { LEGACY_ROUTES, VALID_PAGES } from "./route";

const DEFAULT_HOST = "https://eu.i.posthog.com";

function posthogKey(): string | undefined {
  const key = import.meta.env.VITE_POSTHOG_KEY;
  return typeof key === "string" && key.trim() ? key.trim() : undefined;
}

/** Init PostHog only when VITE_POSTHOG_KEY is set. No identify / no PII. */
export function initPostHog(): void {
  const key = posthogKey();
  if (!key || typeof window === "undefined") {
    return;
  }

  const host =
    typeof import.meta.env.VITE_POSTHOG_HOST === "string" &&
    import.meta.env.VITE_POSTHOG_HOST.trim()
      ? import.meta.env.VITE_POSTHOG_HOST.trim()
      : DEFAULT_HOST;

  posthog.init(key, {
    api_host: host,
    capture_pageview: false,
    capture_pageleave: true,
    persistence: "localStorage",
    person_profiles: "identified_only",
  });

  captureHashPageview();
  window.addEventListener("hashchange", captureHashPageview);
}

/**
 * Known hash routes for $current_url. Anything else is treated as sensitive/unknown
 * and dropped to the bare origin+pathname.
 *
 * Canonical De Pas pages plus their known sub-targets, and the legacy English deep
 * links that `parseHash` still accepts before they rewrite.
 */
const KNOWN_HASH_ROUTES = new Set<string>([
  ...VALID_PAGES,
  "modellen/modellen",
  "modellen/combos",
  "modellen/subagents",
  "verkeer/usage",
  "systeem/storage",
  "systeem/codex-auth",
  "systeem/api",
  "systeem/claude",
  ...Object.keys(LEGACY_ROUTES),
  "logs/debug",
  "providers/workspace",
]);

/** Page heads that are safe to emit even when the sub-target is unknown. */
const KNOWN_PAGE_HEADS = new Set<string>([
  ...VALID_PAGES,
  ...Object.keys(LEGACY_ROUTES),
]);

/** Minimized $current_url: origin + pathname + only a known hash route.
 *  Drops the query string and any unknown hash contents so auth codes,
 *  invitation tokens, or emails never reach PostHog. */
export function sanitizedCurrentUrl(loc: Pick<Location, "origin" | "pathname" | "hash">): string {
  const base = `${loc.origin}${loc.pathname}`;
  const hashRoute = loc.hash.replace(/^#\/?(.*)$/, "$1").replace(/^\/+/, "");
  if (!hashRoute) return base;
  if (KNOWN_HASH_ROUTES.has(hashRoute)) return `${base}#${hashRoute}`;
  // Unknown sub-target on a known page: emit the page head only.
  const head = hashRoute.split("/")[0] ?? "";
  if (KNOWN_PAGE_HEADS.has(head)) return `${base}#${head}`;
  return base;
}

/** Manual $pageview for hash routes (e.g. #leveranciers). */
export function captureHashPageview(): void {
  if (!posthogKey() || !posthog.__loaded) {
    return;
  }

  posthog.capture("$pageview", {
    $current_url: sanitizedCurrentUrl(window.location),
  });
}
