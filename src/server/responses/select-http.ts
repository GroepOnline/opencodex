/**
 * Map Availability first-pick failures to HTTP. The turn owns this; Availability does not.
 */
import { formatErrorResponse } from "../../bridge";
import { cooldownErrorResponse } from "../../codex/auth-context";
import { formatCodexProviderForLog } from "../../codex/routing";
import { getConfigPath } from "../../config";
import type { OauthPoolName, SelectCandidateFail } from "../../availability";
import type { OcxConfig } from "../../types";

const OAUTH_POOL_ALL_COOLED: Record<OauthPoolName, string> = {
  anthropic: "All Anthropic OAuth accounts are temporarily rate-limited",
  "google-antigravity": "All Google Antigravity OAuth accounts are temporarily rate-limited",
  cursor: "All Cursor OAuth accounts are temporarily rate-limited",
};

const OAUTH_POOL_NONE: Record<OauthPoolName, string> = {
  anthropic: "No eligible Anthropic OAuth account available",
  "google-antigravity": "No eligible Google Antigravity OAuth account available",
  cursor: "No eligible Cursor OAuth account available",
};

export function selectCandidateFailResponse(
  pick: SelectCandidateFail,
  args: { providerName: string; config: OcxConfig },
): Response {
  if (pick.kind === "oauth-all-cooled") {
    return formatErrorResponse(
      429,
      "rate_limit_error",
      OAUTH_POOL_ALL_COOLED[pick.pool],
      pick.retryAfterSeconds !== null ? { retryAfter: String(pick.retryAfterSeconds) } : undefined,
    );
  }
  if (pick.kind === "oauth-none") {
    return formatErrorResponse(401, "authentication_error", OAUTH_POOL_NONE[pick.pool]);
  }
  if (pick.kind === "oauth-unsupported") {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      `${pick.message}. Remove or reconfigure provider '${args.providerName}' in ${getConfigPath()}.`,
    );
  }
  if (pick.kind === "vault") {
    return formatErrorResponse(pick.status, pick.type, pick.message);
  }
  if (pick.kind === "codex-cooldown") {
    return cooldownErrorResponse(pick.error);
  }
  if (pick.kind === "codex-affinity-expired") {
    return formatErrorResponse(
      409,
      "invalid_request_error",
      "Codex thread account affinity expired; start a new session",
    );
  }
  if (pick.kind === "codex-reauth") {
    const safeAccountLabel = formatCodexProviderForLog(args.providerName, pick.accountId, args.config);
    console.error(`[codex-auth] Pool account ${safeAccountLabel} token failed; reauthentication required`);
    return formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication");
  }
  if (pick.kind === "codex-unusable") {
    return formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication");
  }
  return formatErrorResponse(401, "authentication_error", pick.message);
}
