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
  hopChainTargets,
  selectHopChain,
  type HopChain,
} from "./chain";
export { resolveOutcome, recordCapOutcome, keyPoolCanHop, selectKeyPoolCandidate, type ResolveOutcomeInput } from "./resolve";
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
export { clearKeyPoolCooldowns } from "./management";
export { comboIdLabel } from "../providers/fallback";
