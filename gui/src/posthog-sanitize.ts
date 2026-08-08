import { KNOWN_VIEW_HASHES, LEGACY_HASH_HEADS, VALID_VIEWS } from "./app-routing";

/**
 * Known hash routes for $current_url. Anything else is treated as sensitive/unknown
 * and dropped to the bare origin+pathname (or the known view head).
 *
 * Keep this list aligned with `app-routing.ts` so PostHog never sees auth codes,
 * invitation tokens, or emails that landed in the hash.
 */
const KNOWN_HASH_ROUTES = new Set<string>([
  ...KNOWN_VIEW_HASHES,
  // Legacy hashes still accepted by resolveAppHashChange before rewrite; emit once.
  "providers/workspace",
  "dashboard/providers",
  "dashboard/models",
  "codex-auth",
  "logs/debug",
  "debug",
]);

/** View heads (and legacy heads) safe to emit even when the sub-target is unknown. */
const KNOWN_PAGE_HEADS = new Set<string>([
  ...VALID_VIEWS,
  ...LEGACY_HASH_HEADS,
]);

/**
 * Minimized $current_url: origin + pathname + only a known hash route.
 * Drops the query string and any unknown hash contents.
 */
export function sanitizedCurrentUrl(loc: Pick<Location, "origin" | "pathname" | "hash">): string {
  const base = `${loc.origin}${loc.pathname}`;
  const hashRoute = loc.hash.replace(/^#\/?(.*)$/, "$1").replace(/^\/+/, "");
  if (!hashRoute) return base;
  if (KNOWN_HASH_ROUTES.has(hashRoute)) return `${base}#${hashRoute}`;
  const head = hashRoute.split("/")[0] ?? "";
  if (KNOWN_PAGE_HEADS.has(head)) return `${base}#${head}`;
  return base;
}

/**
 * String form of `sanitizedCurrentUrl` for PostHog's `sanitize_properties` hook,
 * so automatic events ($pageleave, autocapture) get the same allowlisting as
 * manual $pageview. Unparseable URLs are dropped entirely.
 */
export function sanitizedUrlString(url: string): string {
  try {
    return sanitizedCurrentUrl(new URL(url));
  } catch {
    return "";
  }
}
