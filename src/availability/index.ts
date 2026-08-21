/**
 * Availability: who may take an attempt, and whether an outcome hops or surfaces.
 * Callers: the Responses/Claude turn (select + resolve) and management (inspect/clear).
 * Does not own registry overlay or operator quota bars.
 */
export {
  classifyAttempt,
  isAccountPoolHopStatus,
  type AttemptEvidence,
  type AvailabilityDecision,
} from "./classify";
export {
  rateLimitForFailure,
  parseAnthropicRateLimit,
  parseOpenAIRateLimit,
  parseGenericRateLimit,
  parseProviderRateLimit,
  parseRetryAfterToSec,
} from "./rate-limit-parse";
export {
  selectHopChain,
  canHopNativeClaudePierce,
  type HopChain,
} from "./chain";
export { resolveOutcome, recordCapOutcome, keyPoolCanHop, selectKeyPoolCandidate, type ResolveOutcomeInput, type KeyPoolCandidateResult } from "./resolve";
export {
  selectCandidate,
  type SelectCandidateInput,
  type SelectCandidateOk,
  type SelectCandidateFail,
  type SelectCandidateResult,
} from "./select";
export {
  selectOauthPoolCandidate,
  resolveAnthropicPoolOutcome,
  resolveGoogleAntigravityPoolOutcome,
  resolveCursorPoolOutcome,
  type OauthPoolHop,
  type OauthPoolName,
  type OauthPoolSelectResult,
} from "./oauth-pool";
export {
  selectCodexCandidate,
  resolveCodexPoolOutcome,
  codexQuotaOutcomeMeta,
  shouldDeferCodexResetDerivedCooldown,
  type CodexPoolHop,
  type CodexPoolAuth,
  type CodexSelectResult,
} from "./codex-pool";
export {
  clearKeyPoolCooldowns,
  inspectKeyPool,
  inspectAvailability,
  type InspectedApiKey,
  type AvailabilityProviderView,
} from "./management";
export { comboIdLabel, isProviderFallbackComboId } from "../providers/fallback";
