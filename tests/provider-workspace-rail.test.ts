import { describe, expect, test } from "bun:test";
import { railStatusCls, statusLabel } from "../gui/src/components/provider-workspace/ProviderRail";
import type { WorkspaceItem } from "../gui/src/provider-workspace/catalog";
import type { TFn } from "../gui/src/i18n";
import { canonicalHash, parseHash } from "../gui/src/route";

const t = ((key: string) => ({
  "prov.disabledBadge": "Disabled",
  "pws.status.ready": "Ready",
  "pws.status.needsSetup": "Needs setup",
  "pws.status.needsAttention": "Needs attention",
}[key] ?? key)) as TFn;

function item(overrides: Partial<WorkspaceItem> = {}): WorkspaceItem {
  return {
    name: "example",
    adapter: "openai-chat",
    baseUrl: "https://api.example.com/v1",
    authMode: "key",
    hasApiKey: true,
    ...overrides,
  };
}

describe("provider rail status semantics", () => {
  test("maps visible labels and reinforcing dot classes from the same status", () => {
    expect(statusLabel(item(), t)).toBe("Ready");
    expect(railStatusCls(item())).toContain("--active");
    expect(statusLabel(item({ hasApiKey: false }), t)).toBe("Needs setup");
    expect(railStatusCls(item({ hasApiKey: false }))).toContain("--warning");
    expect(statusLabel(item({ disabled: true }), t)).toBe("Disabled");
    expect(railStatusCls(item({ disabled: true }))).toContain("--inactive");
  });

  test("oauth config-ready with activeNeedsReauth shows amber needs-attention rail status", () => {
    const reauth = item({ authMode: "oauth", activeNeedsReauth: true });
    expect(statusLabel(reauth, t)).toBe("Needs attention");
    expect(railStatusCls(reauth)).toContain("--warning");
    expect(railStatusCls(reauth)).not.toContain("--active");
  });
});

describe("provider rail source contract", () => {
  test("has one page-owned action surface and one option focus model", async () => {
    const shell = await Bun.file("gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx").text();
    expect(shell).not.toContain('className="pws-rail-header"');
    expect(shell).not.toContain('className="pws-rail-title"');
    expect(shell).not.toMatch(/className="pws-rail-list"[\s\S]{0,160}tabIndex=\{0\}/);
    expect(shell).toContain('className="pws-shell-container"');
    expect(shell).toContain('className="pws-rail-group-label"');
    expect(shell).toContain('className="pws-rail-group-count"');
    expect(shell).toContain("railTabbableName");
    expect(shell).toContain("onFocus={() => setRailFocusName(item.name)}");
  });

  test("uses icon, two-line copy, and trail without a chevron sibling", async () => {
    const rail = await Bun.file("gui/src/components/provider-workspace/ProviderRail.tsx").text();
    expect(rail).toContain('className="providers-workspace-rail-copy"');
    expect(rail).toContain('className="providers-workspace-rail-primary"');
    expect(rail).toContain('className="providers-workspace-rail-secondary"');
    expect(rail).not.toContain("providers-workspace-rail-chevron");
    expect(rail).not.toContain("<IconChevron");
    expect(rail).toContain('title={nameTitle}');
  });

  test("pins no-wrap, token, container, and overflow protections", async () => {
    const css = await Bun.file("gui/src/styles/provider-workspace-shell.css").text();
    expect(css).not.toContain("var(--fg");
    expect(css).toContain("container-name: provider-workspace");
    expect(css).toContain(".main-inner:has(.pws-shell-container)");
    expect(css).toMatch(/\.providers-workspace-rail-name-label\s*\{[^}]*white-space:\s*nowrap[^}]*text-overflow:\s*ellipsis/s);
    expect(css).toMatch(/\.providers-workspace-rail-secondary\s*\{[^}]*white-space:\s*nowrap[^}]*text-overflow:\s*ellipsis/s);
    expect((css.match(/\.providers-workspace-rail-row\s*\{/g) ?? []).length).toBe(1);
  });

  test("App threads the parsed sub-target down to each page component", async () => {
    // This host localizes the shell to Dutch page ids and models routing as { page, target };
    // the wiring contract is that App passes the deep-link sub-target to each page.
    const app = await Bun.file("gui/src/App.tsx").text();
    expect(app).toContain("target={route.target}");
    expect(app).not.toContain("window.location.hash !== nextHash");
  });
});

describe("hash routing (parseHash / canonicalHash)", () => {
  test("parses canonical page hashes with and without a sub-target", () => {
    expect(parseHash("#modellen")).toEqual({ page: "modellen", target: undefined });
    expect(parseHash("#/modellen")).toEqual({ page: "modellen", target: undefined });
    expect(parseHash("#modellen/combos")).toEqual({ page: "modellen", target: "combos" });
    expect(parseHash("#systeem/codex-auth")).toEqual({ page: "systeem", target: "codex-auth" });
  });

  test("maps legacy deep links onto the absorbing page and threads their sub-target", () => {
    expect(parseHash("#combos")).toEqual({ page: "modellen", target: "combos" });
    expect(parseHash("#subagents")).toEqual({ page: "modellen", target: "subagents" });
    expect(parseHash("#usage")).toEqual({ page: "verkeer", target: "usage" });
    expect(parseHash("#codex-auth")).toEqual({ page: "systeem", target: "codex-auth" });
    expect(parseHash("#providers")).toEqual({ page: "leveranciers", target: undefined });
  });

  test("falls back to the providers page for empty or unknown hashes", () => {
    expect(parseHash("")).toEqual({ page: "leveranciers", target: undefined });
    expect(parseHash("#")).toEqual({ page: "leveranciers", target: undefined });
    expect(parseHash("#nonsense")).toEqual({ page: "leveranciers", target: undefined });
    expect(parseHash("#modellen-typo/combos")).toEqual({ page: "leveranciers", target: undefined });
  });

  test("canonicalizes a route back to its #/<page>[/<target>] hash body", () => {
    expect(canonicalHash({ page: "modellen" })).toBe("modellen");
    expect(canonicalHash({ page: "modellen", target: "combos" })).toBe("modellen/combos");
    // Legacy alias -> parse -> canonicalize collapses to the canonical form the router rewrites to.
    expect(canonicalHash(parseHash("#combos"))).toBe("modellen/combos");
    expect(canonicalHash(parseHash("#nonsense"))).toBe("leveranciers");
  });
});
