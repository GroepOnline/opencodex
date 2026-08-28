/** Pure hash → view resolution used by App route state.
 *
 * IA (design-system v2, 2026-08): five views — Dashboard (home), Leveranciers,
 * Modellen, Verkeer, Systeem. Pre-IA sidebar hashes are kept as legacy redirects
 * so bookmarks, Back/Forward and external deep links keep working.
 */

import { normalizeHashPath } from "./hash-routing";

export type View = "landing" | "dashboard" | "leveranciers" | "modellen" | "verkeer" | "verbruik" | "systeem";

export const VALID_VIEWS = new Set<View>(["landing", "dashboard", "leveranciers", "modellen", "verkeer", "verbruik", "systeem"]);

/** Sub-views per view (the "/"-suffix, e.g. #leveranciers/claude). */
export const VIEW_SUBS: Record<View, ReadonlySet<string>> = {
  landing: new Set(),
  dashboard: new Set(),
  leveranciers: new Set(["claude", "grok"]),
  modellen: new Set(["combos", "subagents"]),
  verkeer: new Set(["debug"]),
  verbruik: new Set(),
  systeem: new Set(["storage", "api"]),
};

/** Canonical hashes: bare views plus every valid view/sub combination. */
export const KNOWN_VIEW_HASHES: readonly string[] = [
  ...VALID_VIEWS,
  ...(Object.entries(VIEW_SUBS) as [View, ReadonlySet<string>][]).flatMap(([v, subs]) =>
    [...subs].map(s => `${v}/${s}`),
  ),
];

/** Route = view + optional validated sub-view. */
export type Route = { view: View; sub: string | null };

export function canonicalHashFor(route: Route): string {
  return route.sub ? `${route.view}/${route.sub}` : route.view;
}

/**
 * Legacy hash → canonical hash. Every pre-IA hash lands on its new home; unknown
 * content falls back below, never to a dead URL.
 */
const LEGACY_HASH_MAP: Record<string, string> = {
  // `#dashboard` is a first-class view (landing). Only the old nested dashboard
  // paths redirect; bare `dashboard` must not rewrite away from the home page.
  "dashboard/providers": "leveranciers",
  "dashboard/models": "modellen",
  providers: "leveranciers",
  "providers/workspace": "leveranciers",
  "codex-auth": "leveranciers",
  claude: "leveranciers/claude",
  grok: "leveranciers/grok",
  models: "modellen",
  combos: "modellen/combos",
  subagents: "modellen/subagents",
  usage: "verbruik",
  logs: "verkeer",
  "logs/debug": "verkeer/debug",
  debug: "verkeer/debug",
  startup: "systeem",
  storage: "systeem/storage",
  api: "systeem/api",
};

/** Legacy route heads still safe to emit to analytics (see posthog-sanitize). */
export const LEGACY_HASH_HEADS: readonly string[] = [
  "providers",
  "codex-auth",
  "claude",
  "grok",
  "models",
  "combos",
  "subagents",
  "usage",
  "logs",
  "debug",
  "startup",
  "storage",
  "api",
];

export function readRouteFromHash(hash?: string): Route {
  const raw = normalizeHashPath(
    hash ?? (typeof window !== "undefined" ? window.location.hash : ""),
  );
  const canonical = LEGACY_HASH_MAP[raw] ?? raw;
  const [head, sub] = canonical.split("/");
  if (VALID_VIEWS.has(head as View)) {
    const view = head as View;
    return { view, sub: sub && VIEW_SUBS[view].has(sub) ? sub : null };
  }
  // Unknown hashes keep their historic fallback: the dashboard. The public
  // landing lives behind the explicit #landing hash only.
  return { view: "dashboard", sub: null };
}

export function hashBelongsToRoute(rawHash: string, route: Route): boolean {
  const canonical = LEGACY_HASH_MAP[rawHash] ?? rawHash;
  if (canonical === route.view) return route.sub === null;
  return canonical === canonicalHashFor(route);
}

/** Result of resolving an incoming hash. */
export type AppHashChangeAction = {
  route: Route;
  /** When non-null, passively replace the hash (no new history entry). */
  replaceTo: string | null;
};

/**
 * Resolve what App should do for the current location hash.
 * Any rewrite this returns is passive: callers apply it with replaceState, never a
 * push, so Back is never trapped on a hash the router immediately corrects.
 */
export function resolveAppHashChange(rawHash: string): AppHashChangeAction {
  // The `#` prefix is presentation; resolve on the normalized path so a canonical
  // hash like `#leveranciers` is never needlessly rewritten to `leveranciers`.
  const normalized = normalizeHashPath(rawHash);
  // Legacy prefixes with unknown tails (e.g. #codex-auth/accounts) collapse to
  // the legacy head's new home rather than leaking into the fallback.
  const legacyHead = normalized.split("/")[0];
  if (!(normalized in LEGACY_HASH_MAP) && legacyHead && legacyHead in LEGACY_HASH_MAP) {
    const route = readRouteFromHash(legacyHead);
    return { route, replaceTo: canonicalHashFor(route) };
  }

  const route = readRouteFromHash(normalized);
  const canonical = canonicalHashFor(route);
  if (normalized !== canonical) {
    return { route, replaceTo: canonical };
  }
  return { route, replaceTo: null };
}
