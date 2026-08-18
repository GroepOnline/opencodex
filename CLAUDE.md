# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Source-of-truth map

`AGENTS.md` (root) is the canonical agent guide — read it first. Nested `AGENTS.md` files apply per directory: `src/`, `gui/`, `docs-site/`, `scripts/`, `.github/`. Maintainer architecture invariants live in `structure/` (start with `00_overview.md` and `01_runtime.md`; read the relevant file before touching shared routing, adapters, transports, OAuth, config, or server code). When this file and `AGENTS.md` disagree, `AGENTS.md` wins.

## What this project is

opencodex (`ocx`) is a universal provider proxy for OpenAI Codex and Claude Code: a local Responses-compatible proxy (`http://127.0.0.1:<port>/v1/responses`) that routes Codex CLI/App/SDK and Claude Code to many LLM providers. Bun-native TypeScript, strict mode, ES modules only — no server compile step, no Node-only APIs.

Request flow:

```
Codex / Claude Code → src/server/index.ts → src/router.ts (provider/model pick)
  → adapter in src/adapters/ (internal AdapterEvent stream)
  → src/bridge.ts (AdapterEvent → Responses SSE or WebSocket frames)
  → upstream provider
```

Adapters must emit internal `AdapterEvent`s; only `bridge.ts` converts back to Responses form. Provider facts live once in `src/providers/registry.ts` + `derive.ts` — never duplicate provider metadata in pickers or seeds. `src/server/` is split by responsibility (`index.ts` listener/route order, `responses.ts`, `images.ts`, `management-api.ts` for `/api/*`, plus lifecycle/relay/auth-cors files).

## Commands

```bash
bun install
bun run typecheck        # bun x tsc --noEmit (strict) — run before proposing any non-trivial change
bun run test             # full suite, runs isolated (own HOME/OPENCODEX_HOME/CODEX_HOME)
bun run test tests/<name>.test.ts   # single test file (args pass through to bun test --isolate)
bun run lint:gui         # GUI eslint
bun run privacy:scan     # credential/privacy scan; must stay green, never log request bodies/keys/account ids
bun run build:gui        # Vite GUI build
bun run prepush          # typecheck + gui lint + full tests + privacy scan (CI parity)
bun run dev              # run the proxy from source
```

Bun pins test discovery to `tests/` via `bunfig.toml` (`[test] root = "tests"`) — a bare `bun test` stays on the real suite and doesn't drag in vendored trees.

GUI (`gui/`) — for every functional change:

```bash
cd gui && bun test tests && bun run lint && bun run build
# after any UI-copy/locale change also:
bun run lint:i18n
```

docs-site — validate with `cd docs-site && bun install --frozen-lockfile && bun run build`. Don't claim docs validated unless this build passes.

CI runs typecheck/tests on Linux, Windows, and macOS — keep scripts cross-platform.

## Hard rules

- **Branches:** PRs target `dev` (the only integration branch). `main` moves only by maintainer promotion; `preview` is the prerelease train. Never open feature PRs against `main`. The `enforce-target` CI check rejects wrong-base PRs.
- **Tests never hit live provider endpoints** — use fixtures. Place focused regression tests near the subsystem's existing tests; shared routing/adapter/config/OAuth/server changes require the full suite green.
- **Security boundary** (needs explicit security review per `MAINTAINERS.md`): auth, credentials/tokens, OAuth, CORS, `.github/` workflows, release automation (`scripts/release.ts`), dependency installation. Never run `bun run release`/publish/deploy unless the task explicitly requires it and `MAINTAINERS.md` permits.
- **Security findings and unreleased vulnerability work go in scratch space** (`.tmp/` or `mktemp -d`), never in `devlog/`, `structure/`, or `docs-site/` — only the published fix, regression test, and advisory reach the repo.
- **`devlog/` is a private submodule.** Never commit anything under `devlog/` to this repository; commit inside the submodule and bump the pointer separately. Never nest a git repo inside it.
- **Issues are tracked in Linear (MCP), not GitHub Issues** — see `docs/agents/issue-tracker.md`. Triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.
- **Docs sync:** user-visible behavior changes must update `docs-site/` (English canonical; translations must not contradict it).

## Invariants (from `structure/00_overview.md`)

- `websockets` defaults to `false`; only `true` advertises `supports_websockets`.
- `CODEX_HOME` wins over `~/.codex` when present and valid.
- Root TOML keys (`model_provider`, `model_catalog_json`) must stay before any table.
- Routed model slugs use `provider/model`; inner slashes in provider-native ids alias to `-` for Codex.
- OpenAI has one `openai` Codex-login provider (Pool default / Direct mode) and a separate `openai-apikey`; the two credential routes never fall through into one another.
- `ocx stop`, `ocx restore`, and service stop/uninstall must leave native Codex usable.
- Live model discovery is bounded and registry-driven (`src/providers/model-discovery.ts`): reject responses > 4 MiB, > 2 000 raw rows, malformed envelopes, invalid model ids — before caching.

## GUI i18n

No hardcoded visible UI text in `gui/src/pages`, `components`, `App.tsx`, or `ui.tsx`. Every user-facing string goes into `src/i18n/en.ts` (source of truth) and every other locale module. Allowed literals without keys: company/product names, model identifiers, technical/machine text (shell samples, `<pre>`/`<code>` content, env vars, units, URLs) — see `.eslint/i18n-allowlist.ts`. Never hardcode English to "fix" a bad translation; fix the key in all locale files. Keep code comments — don't strip them for i18n.

## Local state (written/owned by opencodex)

`~/.opencodex/config.json` (main config), `~/.opencodex/auth.json` (OAuth tokens, multiauth shape), `~/.opencodex/codex-accounts.json` (account pool), `$CODEX_HOME/config.toml` + `opencodex-catalog.json` (injected into Codex), `$CODEX_HOME/models_cache.json` (invalidated after catalog changes).
