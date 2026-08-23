# Provider / account engine audit (Lane B)

Wave-0 snapshot: `OCX_STATE_SNAPSHOT.yaml` (2026-08-23).
Code under audit: `origin/main` @ `4a589932` (worktree `convergence/lane-b-runtime`).
Live host inspected read-only: `chef-control-az-01` (`/opt/chef/services/opencodex` @ `71c3cad1`, advertised `1.2.1`).

This document is evidence and an incremental design. It does not propose a rewrite.

---

## 1. Current-state map

OCX is a request proxy. The engine that matters is not the static catalog; it is **which upstream identity is used for this request, and what happens when that identity cannot serve**.

```
client
  → src/server/index.ts          admission, auth, surface dispatch
  → src/router.ts                routeModel()  (provider + model + optional combo)
  → src/server/responses/core.ts handleResponses() / handleComboResponses()
       ├ credential resolve      OAuth pool / key / ChefVault / Codex forward
       ├ adapter fetch           src/lib/upstream-retry.ts  (reset + transient 5xx)
       ├ same-provider hop       account pool / apiKeyPool  (429/529)
       └ cross-provider hop      combos + providers[].fallback
  → src/server/request-log.ts    addFinalRequestLog() → src/usage/log.ts
```

### 1.1 Provider registry

| Piece | Where |
| --- | --- |
| Static catalog | `src/providers/registry.ts` — `PROVIDER_REGISTRY`, `getProviderRegistryEntry()`, `providerCodexAccountMode()`, `effectiveGoogleMode()` |
| Config seed / backfill | `src/providers/derive.ts` + `src/router.ts` `routeModel()` (registry fields merged onto the saved row) |
| Routing | `src/router.ts` `routeModel()` — combo first, then `provider/model`, then prefix heuristics |
| Disabled | `OcxProviderConfig.disabled` (`src/types.ts:1003`). Routing, catalog gather, quota probe, and combo eligibility all skip `disabled === true`. |

The registry is **transport + catalog metadata**. It is not an account store. A saved `config.providers[name]` is the operator row; `authMode` is `key | forward | oauth | local`.

### 1.2 Credential / account model

Four identity planes, not one:

| Plane | Persist | Shape | Selector |
| --- | --- | --- | --- |
| OAuth multiauth | `~/.opencodex/auth.json` via `src/oauth/store.ts` | `ProviderAccountSet { activeAccountId, accounts[{ id, credential, needsReauth?, alias? }] }` | `getAccountSet()` / `getValidAccessTokenForAccount()` |
| Codex pool | `codex-accounts.json` + `config.codexAccounts` + `activeCodexAccountId` | credential records with generation / grant fingerprint | `src/codex/routing.ts` + `src/codex/auth-context.ts` |
| API-key pool | `config.providers[name].apiKeyPool` + mirrored `apiKey` | `{ id, key, label?, addedAt? }` | `src/providers/key-failover.ts` `rotateKeyOn429()` |
| ChefVault lease | `credentialRef` (`chefvault://…`) | request-scoped secret, never written back | `src/providers/credential.ts` `resolveProviderApiKey()` |

OAuth credentials: `src/oauth/types.ts` `OAuthCredentials` (`access`, `refresh`, `expires`, optional `email` / `accountId` / `source` / `projectId` / `apiBaseUrl` / `kiro`).

Token refresh: `src/oauth/index.ts` `resolveAccessSnapshotForAccount()` → provider-specific `refresh*AccountWithLock()`. Single-flight per `(provider, account)` (`tokenRefreshes` Map). Cross-process: file lock + generation CAS (`mergeAccountCredential`). Anthropic writes an on-disk refresh intent (`auth.refresh.<provider>.<hash>.lock.json`) to detect torn refreshes.

### 1.3 Pool / selection

Four opt-in same-provider pools share `src/codex/pool-rotation.ts` (RR weights + sticky) and copy-pasted eligibility:

| Pool | Module | Gate | New-session pick | Hop trigger |
| --- | --- | --- | --- | --- |
| Codex | `src/codex/routing.ts` | `openai` + `codexAccountMode: "pool"` | quota / RR / fill-first; thread affinity | 429/402 + scoped quota; soft-avoid on transient |
| Anthropic | `src/oauth/anthropic-routing.ts` | `config.anthropicAccountPool.enabled` | same | `isAccountPoolHopStatus` 429 **or 529** |
| Antigravity | `src/oauth/google-antigravity-routing.ts` | `config.googleAntigravityAccountPool.enabled` | same | 429 **or 529** |
| Cursor | `src/oauth/cursor-routing.ts` | `config.cursorAccountPool.enabled` | same | 429 / RESOURCE_EXHAUSTED / hard quota / overload |

Entry into a request: `src/server/responses/core.ts` `handleResponses()` (~1478–1564) binds a session key, resolves an account, injects the bearer (and Antigravity `project`), then hops in the 429/529 loops (~2697–2791).

Combo / fallback (cross-provider by design): `src/combos/resolve.ts` `pickComboTarget()`, `src/combos/failover.ts` `comboFailureDecision()`, `src/providers/fallback.ts` `providerFallbackPlan()` (synthetic combo). Live Antigravity is configured with `fallback: [{ provider: "deepseek", model: "deepseek-v4-flash" }]`.

### 1.4 Rate-limit / cooldown / expiry

| Mechanism | Persist? | Module |
| --- | --- | --- |
| API-key 429 cooldown | **memory only** (`keyCooldowns`) | `src/providers/key-failover.ts:24` |
| Combo / provider-fallback target cooldown | **memory only** (`targetCooldowns`) | `src/combos/failover.ts:13` |
| OAuth pool cooldown + affinity | **memory only** (`upstreamHealth`, `sessionAffinity`) | three `*-routing.ts` files |
| Pool RR / sticky cursor | **memory only** (`selectionState`) | `src/codex/pool-rotation.ts:14` |
| Codex hard cooldown / soft-avoid / thread affinity / probe lease | **memory only** (`upstreamHealth`, `threadAccountMap`) | `src/codex/routing.ts:132–159` |
| Codex `needsReauth` | **memory only** (`Set`) | `src/codex/account-runtime-state.ts:1` |
| Provider weekly/inference cap | **disk** `config.providerCooldowns` + optional `providers[name].disabled` | `src/providers/cap-cooldown.ts` |
| OAuth `needsReauth` | **disk** `auth.json` | `src/oauth/store.ts:471` `markAccountNeedsReauth()` |
| Token expiry | **disk** `credential.expires` | refresh at `expires - 60s` (`REFRESH_SKEW_MS`) |
| Codex pause | **disk** `config.pausedCodexAccountIds` | `src/codex/account-pause.ts` |
| Quota bars | **memory cache** (5–10 min TTL) | `src/providers/quota.ts` |

`src/codex/routing.ts:51–54` states the Codex RR cursor “now lives in `pool-rotation`'s per-pool selection state **rather than a persisted file**”. Main does **not** persist rotation/cooldown. The snapshot’s “abandoned lineage had persisted rotation” is consistent with this comment: that work is not on `4a589932`.

### 1.5 Retry / failover / execution

| Layer | Bound | Same-provider? |
| --- | --- | --- |
| Keep-alive reset | 3 attempts (`RESET_RETRY_MAX_ATTEMPTS`) | yes |
| Transient 5xx (500/502/503/504/520–522) | 3, skip if slow (>15s) or `Retry-After` > 60s | yes (`sameAccountRetry`) |
| Shared send budget | `OCX_MAX_UPSTREAM_ATTEMPTS = 3` | `src/lib/upstream-attempt-budget.ts` |
| Outcome policy | `src/lib/upstream-outcome.ts` `OUTCOME_POLICIES` | 529 = `overload` → hop, **no** same-account retry |
| Account-pool hop | 3 failovers / request | yes (same provider) |
| Key-pool hop | until a non-cooled key exists | yes |
| Combo / `fallback` | hop on 401/403/404/408/429/5xx unless cyber-policy / context / invalid_request | **cross-provider** |

529 hop is real on this SHA (`bf356b1a` “hop account pools on 529 overload”): `isAccountPoolHopStatus` is `status === 429 || status === 529` (`src/server/responses/core.ts:303–305`).

### 1.6 Usage recording

Wired, not dead.

`addFinalRequestLog()` (`src/server/request-log.ts:717`) → `addRequestLog()` → `appendUsageEntry()` (`src/usage/log.ts:425`) → `~/.opencodex/usage.jsonl`. Surfaces: `/v1/responses` (including native-passthrough terminals), Claude `/v1/messages`, compact, images, search. Persist errors are swallowed (`addRequestLog` empty `catch` at `:324`).

`account` is **not** a first-class account id. It is a suffix scraped from the log label by `providerAccountLabel()` (`src/providers/label.ts:34`) and only matches `p[a-f0-9]{6}` or legacy `main`. Bare `"anthropic"` / `"google-antigravity"` store **no** account.

### 1.7 How config.json is read/written

Confirmed: unversioned JSON at `~/.opencodex/config.json` (or `$OPENCODEX_HOME/config.json`).

| Op | Function | File |
| --- | --- | --- |
| Path | `resolveConfigDir()` / `getConfigPath()` | `src/config.ts:413–422` |
| Read | `loadConfig()` — Zod `configSchema`, merge-defaults on repair, **backup + empty default** on hard failure | `:1195` |
| Write | `saveConfig()` atomic temp+rename | `:1365` |
| Live write | `saveConfigPreservingClaudeCode()` — only `claudeCode` (and bind hostname) are reconciled against disk; **a `providers` hand-edit is clobbered** | `:1607` |
| Auth | `loadAuthStore()` / `persist()` | `src/oauth/store.ts:101,132` |

No `schema_version` field exists in the type or on disk (live confirmed).

---

## 2. State-machine gap table

Target: `UNKNOWN → HEALTHY; HEALTHY → RATE_LIMITED → HEALTHY; HEALTHY → COOLDOWN → HEALTHY; HEALTHY → EXPIRED; HEALTHY → AUTH_FAILED; HEALTHY → DISABLED` with reason codes.

Today there is **no write-side state machine**. `src/oauth/health.ts` `projectOAuthAccountHealth()` (`:58`) is a **read-time projection** over loose flags. Codex health is a second projection over a different in-memory map.

| Stand-in | Kind | File:line | Implied state | Why it is not a state |
| --- | --- | --- | --- | --- |
| `OcxProviderConfig.disabled` | boolean | `src/types.ts:1003` | DISABLED | Operator toggle **and** auto-pause from cap-cooldown. No reason on the flag itself. |
| `ProviderCapCooldown.disabledProvider` | boolean | `src/types.ts:529` | “we flipped disabled” | Ownership bit, not account health. |
| `ProviderAccount.needsReauth` | boolean | `src/oauth/types.ts:39` | AUTH_FAILED | Persisted, but no reason (`unauthorized` vs `refresh_failed` invented later in `health.ts:188`). |
| Codex `reauthAccounts` Set | boolean-in-a-set | `src/codex/account-runtime-state.ts:1–8` | AUTH_FAILED | Lost on restart. |
| `pausedCodexAccountIds[]` | id list | `src/types.ts:733` | DISABLED | Admin pause, orthogonal to health. |
| `AccountHealth.cooldownUntil` + `cooldownSource` | timestamp + 2-enum | `src/oauth/anthropic-routing.ts:52–54` (same in Antigravity `:45`, Cursor `:42`) | RATE_LIMITED or COOLDOWN | Memory only. `retry-after` vs `default` is not RATE_LIMITED vs QUOTA. |
| Codex `CodexUpstreamHealth.cooldownUntil` / `softAvoidUntil` / `consecutiveFailures` | ad-hoc struct | `src/codex/routing.ts:67–104` | RATE_LIMITED + COOLDOWN + flaky | Memory only; two clocks; probe leases. |
| `keyCooldowns.cooldownUntil` | timestamp | `src/providers/key-failover.ts:17–25` | RATE_LIMITED | Memory only; no reason. |
| `targetCooldowns.cooldownUntil` | timestamp | `src/combos/failover.ts:5–13` | COOLDOWN | Memory only. |
| `credential.expires` | epoch ms | `src/oauth/types.ts:16` | EXPIRED | Time, not a state. Background `local-cli` with expired access is treated as unusable, not EXPIRED. |
| `ProviderAccountSet.activeAccountId` | pointer | `src/oauth/types.ts:45` | “the healthy one” | Selection, not health. |
| `runtimeActiveCodexAccountId` | pointer | `src/codex/routing.ts:65` | “automatic cursor” | Memory; deliberately **not** written to `activeCodexAccountId`. |
| `hideUnavailableModels` / discovery streak | boolean + counter | `src/codex/catalog-visibility.ts:21–67` | provider death | Hides picker rows; does not change account state. |
| Quota `unavailable?: true` | boolean | `src/providers/quota.ts:285` | UNKNOWN / AUTH_FAILED | Probe failure, cached 10 min. |

`OAuthAccountHealth` (`src/oauth/health.ts:14`) is the closest existing enum (`healthy | cooldown | reauth_required | warning`) but it is **not consulted by routing**. Routing re-implements eligibility with `needsReauth !== true && !isCooled() && credentialIsUsable()`.

---

## 3. The five operational questions

### (1) Can I execute a request right now?

**Partially, at request time only. No preflight API.**

Answered implicitly by `handleResponses()` succeeding in binding a credential. Failure modes: `401` (no eligible OAuth account / login required), `429` (`all-cooled` + `Retry-After`), `404` (unknown model), provider `disabled`, Codex `CodexAccountCooldownError`.

Missing: a single `canExecute({ provider, model, sessionKey })` that unions disabled + persist health + memory cooldown + token expiry + quota cache. After restart the memory half of “no” disappears, so the honest answer becomes a false “yes”.

Live: `google-antigravity` is OAuth + pool enabled, but **`auth.json` does not exist**, so `getAccountSet()` is empty → execute is “no” until a login that has never been persisted on this host. `openai` and `cursor` are `disabled: true`.

### (2) If yes, via which account?

**Yes for the current request, no as a query.**

`resolve*AccountForSession()` / `resolveCodexAccountForThread()` return `{ accountId, reason }`. Reasons exist (`affinity`, `active`, `lowest-usage`, `round-robin`, `fill-first`, `all-cooled`, `pool-disabled`). They are **not** persisted, not exposed on `/healthz`, and RR `pickRoundRobinAccount()` **mutates** the cursor (there is `peekRoundRobinAccount()` for dry-run only).

Missing: a read-only “next account” that does not advance sticky/RR, and a management field that is an account id (not a `pxxxxxx` log suffix).

### (3) If not, why not?

**Partial, and the reasons disagree.**

Internal reasons (`all-cooled`, `none`, `pool-disabled`) collapse to generic `401` / `429` strings. `ocx doctor` / `collectOAuthHealthEntries()` can say `reauth_required` / `cooldown` **only if** (a) `auth.json` exists and (b) for Codex, the **live proxy** is reachable (`collectOAuthHealthEntriesForCli` — process-local maps are invisible to CLI).

Missing: one reason code on the error body and on the account record.

### (4) When will it likely work again?

**Only while the process that recorded the cooldown is still up, and only if Retry-After / quota `resetAt` was parsed.**

| Source | Usable as “until”? |
| --- | --- |
| Pool `get*PoolRetryAfterSeconds()` | yes, in-process; lost on restart |
| `config.providerCooldowns[name].until` | yes, persisted (weekly/inference only) |
| Quota `fiveHourResetAt` / `customWindows[].resetAt` | yes, if cache is warm |
| API-key / combo cooldown | in-process only; cap 10 min |
| Codex reset-derived cooldown | capped at 15 min even if weekly |

Missing: persist `until` + `reason` per account. Live `providerCooldowns` is `null`.

### (5) Which account consumed how much?

**The engine cannot answer this from production data.**

- Live `usage.jsonl`: **174/174 rows have no `account` field**. Attribution requires a `p[a-f0-9]{6}` suffix that Antigravity/Anthropic/Cursor log labels only get when a pool account id is formatted in (`format*ProviderForLog`). Historical `provider: "anthropic"` rows are unattributable.
- Quota probes (`src/providers/quota.ts`) can answer **for some OAuth providers** (Anthropic 5h/weekly, Cursor monthly, Antigravity Gem/Cla custom windows, Codex WHAM, Kimi `/usages`, xAI billing) — **in memory**, TTL 5–10 min, and Antigravity’s bars are **not wired into selection** (see F3).
- Local usage totals (`src/usage/summary.ts`) aggregate by **provider label**, not account id.

Missing: write `accountId` (stable store id) on every `PersistedUsageEntry`; keep quota cache as a hint, not the ledger.

---

## 4. Ranked findings

Severity: **critical** = wrong identity or lost safety after restart; **high** = systematic wrong pick / silent drop; **medium** = operable but blind; **low** = debt.

### F1 — Account runtime state is memory-only (critical)

**Where:** `src/providers/key-failover.ts:24`; `src/combos/failover.ts:13`; `src/oauth/anthropic-routing.ts:62`; `src/oauth/google-antigravity-routing.ts:76`; `src/oauth/cursor-routing.ts:68`; `src/codex/pool-rotation.ts:14`; `src/codex/routing.ts:65,132,159`; `src/codex/account-runtime-state.ts:1`.

**Why wrong:** 429/529 cooldown, session affinity, RR cursor, Codex hard/soft avoid, and Codex `needsReauth` die with the process. `src/codex/routing.ts:51–54` documents that persistence was removed (“rather than a persisted file”).

**Symptom:** After `systemctl restart opencodex-proxy`, a rate-limited account is immediately eligible again; sticky sessions reshuffle; a Codex account that failed refresh looks healthy. Live unit is `Restart=always` / `RestartSec=5`.

**Proof:** `tests/provider-engine-audit.test.ts` (cooldown / RR / Codex reauth leave no disk artifacts).

### F2 — Live host has no OAuth/Codex account store (critical, production)

**Where:** live `/home/chef/.opencodex/` — **no** `auth.json`, **no** `codex-accounts.json`, **no** `~/.codex/auth.json`. Code expects `src/oauth/store.ts:31` `getAuthStorePath()`.

**Why wrong:** Pool + OAuth providers cannot resolve an identity. `google-antigravity` is `authMode: "oauth"` with `googleAntigravityAccountPool.enabled: true`. `github-copilot` is OAuth. `openai` is disabled forward-pool.

**Symptom:** OAuth routes 401 “Not logged in”; pool selection reason is `none`. Snapshot `active_accounts: UNKNOWN` is not just “no management token” — **the files are absent**.

**Contradicts snapshot:** `data.primary_files` listed config/usage/catalog but not the absence of `auth.json`. `googleAntigravityAccountPool: 2` is the **object key count** (`enabled`, `strategy`), not two accounts.

### F3 — Antigravity quota scoring reads a field the probe never writes (high)

**Where:** probe `src/providers/quota.ts:812–838` `parseAntigravityModelsQuota()` writes `customWindows` (`Gem`/`Cla`) only. Selection `src/oauth/google-antigravity-routing.ts:196–211` `usageScore()` / `hasKnownUsage()` require `fiveHourPercent`.

**Why wrong:** Every live Antigravity quota row is “unknown” (score 100). `strategy: "quota"` (default) never leaves the active account for usage reasons. Live pool is `strategy: "round-robin"`, so this is latent until someone switches strategy or relies on fill-first thresholds.

**Symptom:** Dashboard can show Gem 99% vs 4%; routing still says `reason: "active"`.

**Proof:** `tests/provider-engine-audit.test.ts` “customWindows-only quota is treated as unknown”.

### F4 — Usage log cannot attribute consumption to an account (high)

**Where:** `src/server/request-log.ts:292`; `src/providers/label.ts:34`; live `usage.jsonl` 174 lines, `account` absent on all rows.

**Why wrong:** `account` is a regex on the provider **display** label, not the store id. Non-Codex pool traffic (and any row logged as a bare provider name) stores nothing. `addRequestLog` swallows write failures (`:324`).

**Symptom:** Question (5) is unanswerable. 174 lines / ~3 weeks is sparse for a proxy that is up; mix is `anthropic` 108 (provider **row now missing** from live config), `no-such-provider` 18, `combo` 18, `opencode-free` 8, … Last write `2026-08-22 10:07`. Usage is **wired**, not dead — but it is not an account ledger. Five rows have epoch-zero timestamps (`1970-01-01`).

### F5 — `saveConfigPreservingClaudeCode` clobbers `providers` hand-edits (high)

**Where:** `src/config.ts:1603–1607` (comment: “A hand edit to `providers` is still clobbered”). Writers: key rotation (`key-failover.ts:120`), cap-cooldown (`cap-cooldown.ts:258`), pool auto-enable, management routes.

**Why wrong:** Any request-path save persists the **live** `OcxConfig` object. Concurrent operator edits to accounts/pools/keys lose.

**Symptom:** Dashboard or vim edit to `config.json` disappears after the next 429 rotation or cooldown write.

### F6 — Corrupt `auth.json` / `config.json` can empty the identity plane (high)

**Where:** `src/oauth/store.ts:106–110` parse failure → `backupInvalidConfig()` + `{}`; `src/config.ts:1235–1239` hard Zod failure → `getDefaultConfig()`. `normalizeAccount()` (`:247`) **drops** any account whose credential fails `normalizeCredential`.

**Why wrong:** One bad JSON or one account with a missing `refresh` string removes that account from the pool (or the entire store). Identity-less `saveCredential()` (`:357`) **replaces the active slot** instead of appending.

**Symptom:** Accounts “disappear” after a crashy write, a downgrade, or a re-login without `accountId`/`email`.

### F7 — Combo / `fallback` hops across providers (medium — design, live foot-gun)

**Where:** `src/combos/failover.ts:103–130`; `src/providers/fallback.ts`; live `providers.google-antigravity.fallback → deepseek/deepseek-v4-flash`.

**Why wrong if the invariant is “same-provider failover”:** account pools stay on-provider; `fallback` and combos do not. A 429 on Antigravity can become a DeepSeek bill after the pool is exhausted (or immediately if the pool cannot bind). OmniRoute’s registry note (`registry.ts:1403`) already warns not to stack OCX rotation on that provider; the same caution is not enforced for `fallback`.

**Symptom:** Client asked for Antigravity; logs show `deepseek`. Same-provider hop itself is bounded (3) and correct.

### F8 — OAuth refresh is locked, but Codex AUTH_FAILED is not durable (medium)

**Where:** refresh locks/CAS: `src/oauth/store.ts:151,405`; `src/oauth/index.ts:237–268,339–403`. Codex reauth: `account-runtime-state.ts:1`.

**Why wrong:** OAuth `needsReauth` survives restart; Codex does not. Guardian backoff (`token-guardian.ts:60`) is also memory-only. Live `tokenGuardian.enabled: true` with **no** `auth.json` / `codex-accounts.json` means the guardian is a no-op sweep.

**Symptom:** After restart, a permanently failed Codex grant is retried until it fails again.

### F9 — 529 handling is correct on this SHA, absent on live 1.2.1 (medium / release)

**Where:** `src/server/responses/core.ts:303–305,2733`; commit `bf356b1a`. Live runtime is `71c3cad1` (16 commits behind), **before** the 529 hop.

**Symptom on live:** Anthropic/Antigravity `529` / `overloaded_error` is not hopped; Desktop sees the overload. Transient 502/503 still same-account retry (`upstream-outcome.ts:54`).

### F10 — No unified “can I run?” surface (medium)

**Where:** health is split across `oauth/health.ts`, quota cache, catalog-visibility, cap-cooldown, and four pool routers.

**Symptom:** snapshot `active_accounts` / `unhealthy_accounts` / `request_success_rate` remain UNKNOWN even with a management token: there is no one resource that joins persist + memory + usage.

---

## 5. Proposed target (incremental, this codebase)

Do **not** replace the four routers. Introduce one persistable record they already almost speak.

### 5.1 Record

Add `AccountRuntime` (new file `src/accounts/runtime.ts`) stored at `~/.opencodex/account-runtime.json` (atomic write, same style as `auth.json`):

```ts
type AccountState =
  | "UNKNOWN"
  | "HEALTHY"
  | "RATE_LIMITED"
  | "COOLDOWN"
  | "EXPIRED"
  | "AUTH_FAILED"
  | "DISABLED";

type AccountReason =
  | "observed_ok"
  | "retry_after"          // RATE_LIMITED
  | "quota_window"         // COOLDOWN (resetAt / weekly / inference_cap)
  | "overload_529"         // COOLDOWN
  | "token_expired"
  | "refresh_failed"
  | "unauthorized"
  | "forbidden"
  | "operator_disabled"
  | "operator_paused"
  | "missing_credential"
  | "missing_project"
  | "never_observed";

interface AccountRuntime {
  provider: string;          // "anthropic" | "google-antigravity" | "cursor" | "codex" | "key:<name>"
  accountId: string;         // store id or key id
  state: AccountState;
  reason: AccountReason;
  until?: number;            // ms, for RATE_LIMITED / COOLDOWN / EXPIRED
  generation?: number;
  updatedAt: number;
}
```

Legal transitions (enforce in one `transition()`):

```
UNKNOWN → HEALTHY | AUTH_FAILED | EXPIRED | DISABLED
HEALTHY → RATE_LIMITED | COOLDOWN | EXPIRED | AUTH_FAILED | DISABLED
RATE_LIMITED → HEALTHY | COOLDOWN | AUTH_FAILED   (until elapsed or success)
COOLDOWN → HEALTHY | AUTH_FAILED
EXPIRED → HEALTHY | AUTH_FAILED
AUTH_FAILED → HEALTHY          (only after successful re-login)
DISABLED → HEALTHY | UNKNOWN   (operator resume)
```

### 5.2 Fit to existing code (no rewrite)

1. **Hydrate on `startServer`:** load `account-runtime.json` into the existing Maps (`upstreamHealth`, `keyCooldowns`, Codex `reauthAccounts`). Keep the Maps as the hot path.
2. **Write-through:** `rotate*On429`, `rotateKeyOn429`, `markAccountNeedsReauth`, `recordProviderCapCooldown`, Codex `recordCodexUpstreamOutcome` call `transition()` then persist (debounce like cap-cooldown’s “don’t fsync every retry”).
3. **Replace booleans at the edges, not in the middle:** `needsReauth` becomes `state === "AUTH_FAILED"`; `disabled` stays operator DISABLED; `isCooled()` becomes `state ∈ {RATE_LIMITED, COOLDOWN} && until > now`.
4. **Promote `projectOAuthAccountHealth()`** from a GUI projection to the **only** reader used by doctor, management, and `canExecute()`.
5. **Fix F3** in `usageScore()`: for Antigravity, `max(customWindows[].percent)` (same shape the probe already stores). One function, no new API.
6. **Fix F4:** `PersistedUsageEntry.accountId` = store id used for the attempt (`anthropicPoolAccountId` etc. already in `handleResponses`). Keep `account` suffix for display.
7. **Add `GET /api/accounts/can-execute?provider=&model=`** that returns `{ ok, accountId, state, reason, until }` without advancing RR (use `peekRoundRobinAccount` + existing resolve with a `peek` flag).
8. **Do not persist RR weights** until (1) is shipped; persist cooldown + AUTH_FAILED first. That is the restart-safety invariant.

### 5.3 What this engine still will not be

It will not be a LiteLLM clone. Combos remain an explicit **cross-provider** operator construct. Account pools remain **same-provider**. The state machine is the missing control plane for “multiple upstream identities”.

---

## 6. Tests and commands

Characterization tests (this lane): `tests/provider-engine-audit.test.ts`

- key / Antigravity / Codex runtime state is not persisted
- Antigravity `customWindows` does not move a quota pick
- `usage.jsonl` omits `account` without a Codex-style suffix

Existing coverage already pins hop/CAS/529 behaviour: `tests/key-failover.test.ts`, `tests/google-antigravity-account-pool.test.ts`, `tests/anthropic-account-pool.test.ts`, `tests/cursor-account-pool.test.ts`, `tests/codex-pool-rotation.test.ts`.

Measured on this worktree (`4a589932` + this lane):

| Command | Result |
| --- | --- |
| `bun test` (12 engine files, including the new audit file) | **162 pass, 0 fail**, 637 expects, 3.95s (bun 1.3.14) |
| `bun x tsc --noEmit` | **exit 0**, 79.4s |

Full suite (~6700 tests) was not run; the engine subset above is the authority for this lane.

---

## 7. Snapshot contradictions (Lane B scope)

| Snapshot claim | This audit |
| --- | --- |
| `usage.jsonl` 174 lines, last write 2026-08-22 | Confirmed. Recording **is wired**; it is account-blind and sparse, not absent. |
| `googleAntigravityAccountPool: 2` | Confirmed as **two config keys**, not two accounts. Zero OAuth accounts on disk. |
| `active_accounts: UNKNOWN` because no management token | Also UNKNOWN because **`auth.json` / `codex-accounts.json` are missing**. |
| Unversioned `~/.opencodex/config.json` | Confirmed. `loadConfig` / `saveConfig` / `saveConfigPreservingClaudeCode`. No `schema_version`. |
| 18 providers | Confirmed. Live disabled: `openai`, `cursor`, `api-for-cursor`, `opencode-go`, `openrouter`. **`anthropic` provider row is gone** while 108 historical usage rows say `anthropic`. |
| Persisted rotation on an abandoned lineage | Confirmed **absent on main**: comment + in-memory Maps only. |
| Live SHA `71c3cad1` / version `1.2.1` | Confirmed. This branch includes 529 hop (`bf356b1a`) which **live does not run**. |
| `tokenGuardian` | Live has `enabled: true`. Ineffective without an auth store. |

No production mutations were performed. SSH was `cat`/`ls`/`python3` read of JSONL/config only.
