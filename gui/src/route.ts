export type Page = "leveranciers" | "modellen" | "verkeer" | "systeem";

export const VALID_PAGES = new Set<Page>(["leveranciers", "modellen", "verkeer", "systeem"]);

export interface Route { page: Page; target?: string }

/**
 * Legacy deep links from the old 11-page shell land on the view that absorbed them, carrying a
 * sub-target so the destination opens the right tab/section instead of its default. Old bookmarks
 * to #codex-auth / #api / #claude / #combos / #subagents used to collapse to just the parent page;
 * threading the target keeps them landing where the user expects. Canonical form: #/<page>[/<target>].
 */
export const LEGACY_ROUTES: Record<string, Route> = {
  dashboard: { page: "systeem" },
  providers: { page: "leveranciers" },
  models: { page: "modellen", target: "modellen" },
  combos: { page: "modellen", target: "combos" },
  subagents: { page: "modellen", target: "subagents" },
  logs: { page: "verkeer" },
  debug: { page: "verkeer" },
  usage: { page: "verkeer", target: "usage" },
  storage: { page: "systeem", target: "storage" },
  "codex-auth": { page: "systeem", target: "codex-auth" },
  api: { page: "systeem", target: "api" },
  claude: { page: "systeem", target: "claude" },
};

/** Parse a raw `location.hash` (with or without a leading `#` / `#/`) into a route. */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [head, sub] = raw.split("/");
  if (VALID_PAGES.has(head as Page)) return { page: head as Page, target: sub || undefined };
  return LEGACY_ROUTES[head] ?? { page: "leveranciers" };
}

export function canonicalHash(route: Route): string {
  return route.target ? `${route.page}/${route.target}` : route.page;
}
