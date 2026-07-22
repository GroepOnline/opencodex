/**
 * OAuth providers where subscription login into a third-party proxy
 * (OpenCodex) carries elevated Terms-of-Service / account-action risk.
 *
 * High: provider docs/ToS explicitly restrict subscription OAuth to official apps.
 * Elevated: reverse-engineered / unofficial bridges; abuse detection may suspend access.
 */
export type OAuthTosRiskLevel = "high" | "elevated";

const HIGH_RISK = new Set(["anthropic", "google-antigravity"]);
// ChefGroep host patch: "cursor" removed so the OAuth ToS warning modal never blocks the
// multi-account Cursor login flow (previously applied as a minified-dist patch, see
// gui/dist/assets/*.pre-oauth-tos-cursor.bak on the joep host).
const ELEVATED_RISK = new Set(["github-copilot"]);

export function oauthTosRisk(providerId: string): OAuthTosRiskLevel | null {
  const id = providerId.trim().toLowerCase();
  if (HIGH_RISK.has(id)) return "high";
  if (ELEVATED_RISK.has(id)) return "elevated";
  return null;
}

export function oauthTosRiskTitleKey(level: OAuthTosRiskLevel): "oauthTos.highTitle" | "oauthTos.elevatedTitle" {
  switch (level) {
    case "high":
      return "oauthTos.highTitle";
    case "elevated":
      return "oauthTos.elevatedTitle";
    default: {
      const _exhaustive: never = level;
      return _exhaustive;
    }
  }
}

export function oauthTosRiskBodyKey(level: OAuthTosRiskLevel): "oauthTos.highBody" | "oauthTos.elevatedBody" {
  switch (level) {
    case "high":
      return "oauthTos.highBody";
    case "elevated":
      return "oauthTos.elevatedBody";
    default: {
      const _exhaustive: never = level;
      return _exhaustive;
    }
  }
}
