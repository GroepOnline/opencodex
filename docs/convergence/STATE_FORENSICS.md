# OCX production state forensics

Lane C (state authority). Captured 2026-08-23 by read-only observation of
`chef-control-az-01` plus local git history on `origin/main` @ `4a589932`.
No files were written, moved, deleted, chmod'd, restarted, or restored on the
host. Secret values (API keys, OAuth tokens, cookies, admin/service tokens)
were never printed; this report uses names, ids, lengths, env-ref flags, and
content hashes only.

The question is not "where is the old data". It is: which persistent states
have ever held production authority for OCX, and can we prove nothing was
lost?

Verdict: **we cannot prove completeness**. The live Azure store is internally
consistent against every *reachable* legacy copy of the same files. The prior
host is offline, and the live store has no `auth.json`. Those two facts leave
an unclosed hole.

## 1. Authority map (what actually holds state)

OCX has no database. Authority is a directory of JSON/JSONL plus a systemd
`EnvironmentFile` of provider key *names*. The unit
`opencodex-proxy.service` (`Active: running`, bun pid 413295, advertised
`1.2.1`) binds `100.109.39.86:10100` and has
`ReadWritePaths=/home/chef/.opencodex /var/lib/chef /opt/chef/services/opencodex`.
`OPENCODEX_HOME` is unset, so `src/config.ts` `resolveConfigDir()` uses
`~/.opencodex`.

| Role | Path | What it is | Held authority? |
| --- | --- | --- | --- |
| **CURRENT store** | `/home/chef/.opencodex/` | Live JSON/JSONL. `config.json` 89213 B, mtime 2026-08-22 10:10Z. | **Yes — sole live authority today.** |
| **CURRENT Codex injection** | `/home/chef/.codex/` | Regenerated on every proxy start (mtime 2026-08-23 02:55Z, same second as pid). No `auth.json`. Journal `originalConfig` is empty. | Derived, not a user store. |
| **Staged snapshot** | `/etc/chef/opencodex/` | root:chef. `config.json` 70641 B, mtime 2026-08-22 06:34Z, plus `service.env` (15 names), `admin-api-token`, `service-api-token`. | Frozen copy of the live store taken ~4 h earlier the same day. Not read by the running unit except `EnvironmentFile` + `LoadCredential`. |
| **Secrets file** | `/etc/chef/opencodex/service.env` | 15 key *names* only (see below). | Credential *source* for env-ref providers. |
| Code backup 2026-08-22 | `/opt/chef/services/.opencodex-backup-20260822T095647Z` | Full git checkout, `@groeponline/opencodex@1.1.1`. Zero state files. | Never. |
| Pre-git install 2026-08-22 | `/opt/chef/services/opencodex.pre-git-20260822T133750Z` | npm layout, `@groeponline/opencodex@1.2.1`. Zero state files. | Never. |
| Live runtime checkout | `/opt/chef/services/opencodex` | SHA `71c3cad1`, branch `live-v1.2.1`, version 1.2.1. Zero state files. | Code only. |
| Deploy checkout | `/home/chef/opencodex-psp` | SHA `4a589932`, version 1.2.2. No `.opencodex/`. Zero state files. | Code only (and not the running path — V1). |
| Binary seal | `/home/chef/.opencodex/backups/native-binary-seal-20260731T000839Z` | `ocx.npm-bin` + `opencodex.target`. 20 K, no config. | Never. |
| `/var/lib/chef/backups` | vault + authentik tarballs only | Enumerated. No `opencodex` / `.opencodex` / `config.json`. | Never for OCX. |
| `/var/lib/chef/rollback` | systemd-unit snapshots for vault/authentik | Enumerated. No OCX unit. | Never for OCX. |
| **PRIOR host** | `chef-control-01` (`100.115.43.1`) | Tailscale **offline**, last seen `2026-08-22T01:31:44Z`. SSH/ping timeout. | **Unknown — unreachable.** Previously the named production host (`deploy.yml` still says so). |

`service.env` key names (values not read into this document):
`OPENCODEX_API_AUTH_TOKEN`, `CURSOR_USER_API_KEY`, `CLINE_API_KEY`,
`GROQ_API_KEY`, `NVIDIA_API_KEY`, `OPENCODE_GO_API_KEY`, `ZAI_API_KEY`,
`ZAI_PLATFORM_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`,
`OPENCODE_API_KEY`, `ZAI_CODING_PLAN_API_KEY`, `CF_ACCESS_TEAM_DOMAIN`,
`CF_ACCESS_AUD`, `CF_ACCESS_ALLOWED_HOSTS`.

There is no OCX timer. Host timers backup Authentik and Vault, not
`~/.opencodex`. Cron has no OCX job. `config.json` has no `schemaVersion` /
`schema_version`. `storageCleanupPolicy` is unset.

## 2. Lineage

```
                         chef-control-01  (PRIOR authority)
                         ~/.opencodex + ?auth.json + ?codex-accounts.json
                         last seen 2026-08-22T01:31:44Z   OFFLINE
                                |
                                |  2026-08-03/04 host move
                                |  evidence: kimi-device-id 2026-08-03,
                                |  admin-api-token.bak-pre-control-20260804
                                |  (sha != live token — token was rotated),
                                |  usage.jsonl starts 2026-08-03 (32 rows)
                                |  SETUP.md still describes joep/sofie/control-01
                                v
                     chef-control-az-01  (CURRENT authority)
                     /home/chef/.opencodex/
                     config.json  openaiProviderTierVersion=2
                     NO auth.json   NO codex-accounts.json
                     NO config.json.pre-openai-tiers-v2.bak
                                |
          +---------------------+----------------------+
          |                     |                      |
          v                     v                      v
  /etc/chef/opencodex/   live checkout            deploy checkout
  config.json 70KB       /opt/chef/services/      /home/chef/opencodex-psp
  2026-08-22 06:34Z      opencodex @ 71c3cad1     @ 4a589932  (1.2.2)
  same 18 provider ids   1.2.1  live-v1.2.1       NOT the running path
  same 876 disabled      no state files           no state files
  same apiKey ids
  MISSING desktopProfile
          |
          +-- 2026-08-22 09:56  code-only trees (NOT datastores)
              .opencodex-backup-20260822T095647Z   (repo 1.1.1)
              opencodex.pre-git-20260822T133750Z   (npm 1.2.1)

Code-level format migrations that DID exist (git), vs what the live disk shows:

  auth.json legacy → multiauth     (src/oauth/store.ts, one-time
                                    auth.json.pre-multiauth)     ABSENT on disk
  openai-multi/chatgpt → openai v2 (openaiProviderTierVersion,
                                    config.json.pre-openai-tiers-v2.bak)
                                    live file is already v2; backup ABSENT
  Alibaba region backup            (config.json.pre-alibaba-region-v1.bak) ABSENT
  Claude authMode three-state      claudeCode.authModeMigratedAt present
  Codex history guardian           journal says 0 threads remapped
  schema_version                   NEVER existed in src/types.ts or configSchema
```

The 2026-08-22 trees named `*backup*` / `*pre-git*` are **runtime-code
snapshots**, not datastore snapshots. Treating them as recoverable OCX state
would be a category error.

The 2026-08-04 move **did copy the config-shaped home**: usage from 2026-08-03,
device ids from 2026-08-03, a pre-control admin-token bak, and a SETUP.md that
still talks about tunneling to control-01. It did **not** leave an `auth.json`
on Azure, and we cannot see whether one existed on control-01.

## 3. Record-level reconciliation

Sources compared:

- **current** = `/home/chef/.opencodex`
- **etc** = `/etc/chef/opencodex` (only other reachable config-shaped store)
- **code-legacy-1.1.1** = `.opencodex-backup-20260822T095647Z` (no state)
- **code-legacy-1.2.1** = `opencodex.pre-git-20260822T133750Z` (no state)
- **control-01** = unreachable

Provider objects in current vs etc are **byte-identical** (18/18). The 89213 vs
70641 byte gap is `claudeCode.desktopProfile`, present only on current
(added after the 06:34Z snapshot). Disabled-model set hash
`ee2334c82007d978` matches (876 ids). Admission-key id
`e224fe64-19e2-4cce-a9c3-3d32dbae2904` matches (name `default`, created
2026-07-31, key length 44, not an env-ref). Combo `google-combo` matches
(2 google targets, failover). Admin token sha of etc == current; both differ
from `admin-api-token.bak-pre-control-20260804` (same length 53, different
content). Service-api-token sha of etc == current (length 32).

| Domain | current | etc | code-legacy ×2 | control-01 | Missing from current | Conflicts |
| --- | ---: | ---: | ---: | --- | --- | --- |
| providers | 18 | 18 | 0 | UNREACHABLE | none vs etc | none vs etc (adapter/authMode/disabled/pool ids) |
| oauth providers in `auth.json` | **0 (file absent)** | 0 | 0 | UNREACHABLE | **entire auth store if control-01 had one** | n/a |
| oauth accounts | 0 | 0 | 0 | UNREACHABLE | **unknown** | n/a |
| Codex pool accounts (`codex-accounts.json`) | **0 (file absent)** | 0 | 0 | UNREACHABLE | **unknown** | n/a |
| `config.codexAccounts` | 0 | 0 | 0 | UNREACHABLE | none vs etc | n/a |
| admission `apiKeys` | 1 | 1 | 0 | UNREACHABLE | none vs etc | none |
| provider `apiKey` present | 11 | 11 | 0 | UNREACHABLE | none vs etc | none (same env-ref / length) |
| provider `apiKeyPool` entries | 13 | 13 | 0 | UNREACHABLE | none vs etc | none (same ids) |
| env-ref keys | 7 | 7 | 0 | — | — | — |
| inline keys (length only) | 6 | 6 | 0 | — | — | — |
| `disabledModels` | 876 | 876 | 0 | UNREACHABLE | 0 | 0 |
| `subagentModels` | 4 | 4 | 0 | UNREACHABLE | 0 | 0 |
| `providerContextCaps` | 7 | 7 | 0 | UNREACHABLE | 0 | 0 |
| `providerCooldowns` | 0 | 0 | 0 | UNREACHABLE | 0 | 0 |
| combos | 1 | 1 | 0 | UNREACHABLE | 0 | 0 |
| usage.jsonl lines | 174 | 0 | 0 | UNREACHABLE | none vs reachable sources; **pre-2026-08-03 history unknown** | 5 bogus `ocx-early` rows at ts=1000 |
| usage request ids | 170 unique | 0 | 0 | UNREACHABLE | unknown before 2026-08-03 | — |
| responses-state | v2, 3 keys | 0 | 0 | UNREACHABLE | — | — |
| `schemaVersion` | **absent** | **absent** | — | — | — | — |

Current providers (disabled noted): `openai` (disabled, forward), `cursor`
(disabled, oauth), `google-antigravity` (oauth), `github-copilot` (oauth),
`opencode-free` (key, no key — keyOptional), `mimo-free` (key, no key —
keyOptional), `api-for-cursor` (disabled, env-ref + 2 pool ids `2f193882`,
`a89443c4`), `cline-pass`, `groq`, `nvidia`, `opencode-go` (disabled), `zai`,
`openrouter` (disabled), `deepseek` (2 pool ids `34b8a2c2`, `13e6526e`),
`google`, `vercel-ai-gateway`, `orcarouter`, `kilo`.

Default provider is `deepseek`. `hostname` is the tailscale bind
`100.109.39.86`. `effortCap` / `subagentEffortCap` = `low`.
`googleAntigravityAccountPool.enabled` = true, strategy `round-robin`.
`tokenGuardian.enabled` = true. `claudeCode.authMode` = `proxy`.
Three oauth-mode providers are configured and **have no on-disk tokens**.

Usage days on current: 2026-08-03:32, 08-08:64, 08-14:8, 08-18:33, 08-21:8,
08-22:24, plus 5 bogus `ocx-early` rows. Providers seen in the log:
`anthropic` 108 (Claude inbound surface, not a configured provider),
`combo` 18, `no-such-provider` 18, `kilo` 10, `opencode-free` 8, `deepseek` 6,
`unknown` 3, `anthropic-native` 1, `github-copilot` 1, `orcarouter` 1.
**No `google-antigravity` rows.** Success-ish 154 / fail-ish 20.

Catalog backups `catalog-backup.json`, `catalog-backup-5f03f1706cc5a50f.json`,
`catalog-backup-aaa4c6cf793fb310.json` are the same 321150 B / same sha
(8 models). They are Codex catalog snapshots, not config history.

`~/.codex` has no ChatGPT `auth.json`. Extra homes
(`~/.claude`, `~/.grok`, `~/.cursor`, `~/.factory`, `~/.junie`) are absent.
A host-wide find for `auth.json` / `codex-accounts.json` under
`/home/chef`, `/opt/chef`, `/etc/chef`, `/var/lib/chef` returned none.

## 4. What is missing if chef-control-01 never returns

Proven already on Azure (so not uniquely at risk):

- The 18-provider config, 876 disabled models, combo, admission key id,
  usage from 2026-08-03 onward, device ids, rotated admin token, service token.

Unprovable, and lost-if-offline:

1. **`~/.opencodex/auth.json` and `auth.json.pre-multiauth`.** Three live
   providers are `authMode=oauth` (`cursor` disabled, `google-antigravity`
   and `github-copilot` enabled). Zero token files exist on Azure. If those
   logins were completed on control-01, the refresh tokens were not migrated.
   Re-login is the only recovery. If they were never completed, nothing was
   lost — we cannot tell which.
2. **`~/.opencodex/codex-accounts.json` and any ChatGPT `~/.codex/auth.json`.**
   Azure journal `originalConfig` is empty; current `.codex` is a fresh
   inject. Any Codex Desktop / pool credentials on control-01 are gone.
3. **usage.jsonl before 2026-08-03.** Current file starts the day of the
   host-move artifacts. Earlier request history has no reachable copy.
4. **format-migration backups** (`config.json.pre-openai-tiers-v2.bak`,
   Alibaba region bak). Live config is already v2, so rollback-to-v1 is
   impossible from Azure disk alone.
5. **anything else under the old home** (hand-edited config, extra apiKey
   pool entries, older disabled-model sets). The Azure copy looks like a
   single tree that kept being written (config mtime 10:10Z, usage 10:07Z
   on 2026-08-22), not a merge of two authorities.

Risk if it stays offline: **oauth session continuity is the real one**.
Provider *configuration* survived. Tokens may not have. Key-auth providers
that use env-refs still resolve from `service.env`; the six inline keys live
in current `config.json` and the etc snapshot (same lengths).

## 5. Code migration paths (what the repo actually does)

There is **no general `schemaVersion`** and no scheduled backup. `loadConfig`
(`src/config.ts:1195`) / `saveConfig` (`:1365`) / `configSchema` (`:741`) /
`getDefaultConfig` (`:1659`) read and write the whole JSON object with
passthrough + a merge-defaults repair. Invalid files are copied to
`config.json.invalid-<iso>` and replaced with defaults (data-loss path).

Targeted migrations that do exist:

| Path | Trigger | Backup | On Azure disk |
| --- | --- | --- | --- |
| `runOpenAiTierStartupMigration` | startup, if projection.changed | `config.json.pre-openai-tiers-v2.bak` via `backupConfigBeforeOpenAiTierMigration` | already v2; bak absent |
| `oauth/store.ts` `backupLegacyOnce` | first persist of multiauth over legacy | `auth.json.pre-multiauth` | both absent |
| `alibaba-region-backup.ts` | Alibaba region rewrite | `config.json.pre-alibaba-region-v1.bak` | absent |
| history-migration guardian | Codex thread visibility | journal | 0 threads |
| Claude `authMode` three-state | load/reconcile | in-object `authModeMigratedAt` | present |

A host-to-host OCX state promotion pipeline has never existed. That is what
`scripts/state-reconcile.ts` now is (design + implementation, dry-run
default, not executed against production).

## 6. Promotion pipeline (design = the committed script)

`bun scripts/state-reconcile.ts` runs exactly:

1. **Backup current** into `--backup-dir` with a sha256 manifest of the
   state filenames (`config.json`, `auth.json`, `codex-accounts.json`,
   `usage.jsonl`, tokens, …). Apply/promote **refuse** without a verified
   manifest; tamper fails verification.
2. **Import legacy into staging** (`--staging`). Current is never the write
   target.
3. **Schema normalize** — stamp `schemaVersion: 1`, lift legacy single-slot
   auth.json into `{activeAccountId, accounts[]}`, seed `apiKeyPool` from a
   bare `apiKey`.
4. **Dedupe** — provider name, apiKey id, oauth `(provider, account id)`,
   combo id, disabled-model set-union, usage `(requestId, timestamp)`.
   Default `--prefer current`.
5. **Referential checks** — combo targets must name a provider; `authMode=oauth`
   without auth.json accounts is a FAIL row (the Azure situation).
6. **Record-count reconciliation** — printed per domain: current count,
   per-legacy count, missing ids, conflicts.
7. **Functional smoke** — `validateConfigCandidate`, auth shape, JSONL parse.
8. **Promote** — only with `--apply --promote`. Copies live →
   `--backup-dir/pre-promote`, writes a rollback pointer, then copies
   staging → live. `--rollback` reverses that.

Safety properties:

- Default is dry-run. Dry-run writes nothing under current/legacy/backup/staging
  (preview materialization uses `os.tmpdir()` and deletes it).
- Apply writes staging only.
- Promote is the only live writer.
- Idempotent: a second apply against the same inputs yields the same
  `stagingDigest`.
- Reversible via the pre-promote snapshot.
- Diff/report redacts `apiKey` / `key` / `access` / `refresh` / token values
  to length + env-ref.
- Not executed against production in this lane.

## 7. Minimal schema version + backup (proposal only)

Do not invent a second config file. Add one field next to the existing
migration marker.

**Field.** `schemaVersion?: number` on `OcxConfig` (`src/types.ts` ~533) and
`configSchema` (`src/config.ts` ~741), camelCase to match
`openaiProviderTierVersion`. On-disk absence means **1**.
`getDefaultConfig()` writes `schemaVersion: 1`. `loadConfig` /
`readConfigDiagnostics` treat missing as 1 and do not rewrite the file on
read. `saveConfig` / `saveConfigPreservingClaudeCode` persist whatever is on
the object; the first ordinary save after deploy stamps `1`. Bump the
constant in one place when a future rewrite needs a gate. Do not alias
`schema_version` unless a hand-edited file is found — none exists on Azure.

**Backup.** Two layers, both missing today:

1. On `saveConfig` success, hard-link/copy `config.json` to
   `~/.opencodex/backups/config/config-<iso>.json` and keep 14 copies. Reuse
   `atomicWriteFile` + `backupConfigBeforeOpenAiTierMigration`'s
   no-replace discipline. Same for `auth.json` when the oauth store writes.
2. A systemd timer modeled on `chef-vault-backup.timer` (already on the host)
   that copies the `STATE_FILES` list from `scripts/state-reconcile.ts` into
   `/var/lib/chef/backups/opencodex/<iso>/` with a sha256 manifest. Daily is
   enough; the store is tens of kilobytes plus 2.7 MB catalogs if included.

Until both exist, V8 stays open: one bad `saveConfig` after a schema
mismatch still hits `backupInvalidConfig` and can drop providers on the
unrecoverable-parse path.

## 8. Open UNKNOWNs (need a human)

1. **Did chef-control-01 ever have `auth.json`?** If yes, promote is a
   re-login project, not a file copy, unless the disk comes back.
2. **Should the offline host be powered on / imaged before it is wiped?**
   Last seen 2026-08-22 01:31Z. Every day increases the chance the disk is
   gone.
3. **Are the six inline (non-env-ref) provider keys supposed to move into
   `service.env`?** They live in `config.json` today. Out of scope to change.
4. **`no-such-provider` (18) and `unknown` (3) usage rows** — operator
   error vs a dropped provider name from an older config we cannot see.
5. **Keep or delete `/etc/chef/opencodex/config.json`?** It is a useful
   2026-08-22 06:34Z rollback point but it is also a second copy of live
   secrets sitting next to `service.env`.
6. **Stamp `schemaVersion` on the next ordinary save, or wait for a
   dedicated migrate PR?** Recommendation: dedicated PR so the first write
   is intentional.
7. **Who owns restoring google-antigravity / github-copilot / cursor
   sessions?** Config says they exist; the token file does not.

## 9. Safety attestation

- Production (`chef-control-az-01`) was accessed only with read-only
  commands (`ls`, `find`, `stat`, `cat` / `sudo cat`, `systemctl status|cat`,
  `curl` to `/healthz`, `node` over SSH stdin). No writes, moves, deletes,
  chmods, restarts, restores, or cron/timer changes.
- `scripts/state-reconcile.ts` was not pointed at the live store.
- This document contains no API key, token, cookie, or refresh-token
  values. `/etc/chef/opencodex/service.env` is reported by key name only.
- No merge, push, tag, or PR was created.
