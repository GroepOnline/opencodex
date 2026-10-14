---
title: Claude Desktop laptop sync
description: Configure and synchronize Claude Desktop routing profiles.
---

The Claude Desktop page can apply a profile and offer **Sync to this laptop**. On Linux, the sync link launches `ocx-desktop://sync` through the optional OCX protocol handler. **Save & Apply** writes the profile on the proxy but does not launch sync automatically. The CLI sync command works without a protocol handler on all supported platforms.

## Optional Linux sync link

```bash
ocx claude desktop protocol install
ocx claude desktop protocol status
ocx claude desktop protocol uninstall
ocx claude desktop doctor --json
```

Install registers the exact `ocx-desktop://sync` action for the current user. OCX records versioned file ownership and refuses foreign files or symlinks instead of replacing them. Package updates repair an already-owned handler through the newly installed CLI; they never install one automatically. Protocol status verifies owned files; `doctor --json` separately reports when the current XDG default handler cannot be verified, as a warning rather than a false success. Uninstall removes proven-owned handler files and its own default association where registered, refreshing the desktop database without deleting a foreign handler.

An older, unversioned helper is not adopted automatically. If installation reports foreign files, keep using `ocx claude desktop sync` until those files have been reviewed and migrated. Runtime executable paths containing `=` or `%` cannot be registered because Linux Desktop/GIO cannot launch them reliably.

## Authentication

The data-plane library endpoint is `GET /v1/claude-desktop-3p-library`. It requires a data-plane admission secret even on loopback, with the same origin policy as other data-plane routes. The dashboard management route `GET /api/claude-desktop/3p-library` uses management authentication (admin token, GUI session, or Cloudflare Access) instead.

## Secret handling

The response is the applied 3P library and may contain `inferenceGatewayApiKey`. Treat it as a secret: use HTTPS or a protected local tunnel, do not log the response, and do not share the sync URL or response contents.

## Workflow

1. Edit the Claude Desktop profile in the dashboard.
2. Select **Save & Apply** and wait for confirmation on the proxy.
3. Run `ocx claude desktop sync` to copy the applied library through the configured Claude Code loopback gateway. The command checks `OPENCODEX_API_KEY` first, then the data-plane token resolver (`OPENCODEX_API_AUTH_TOKEN`, `OCX_API_TOKEN_FILE`, or the service-token file), then `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` from the environment followed by Claude Code `settings.json`, and finally the existing `apiKeyHelper`. Settings come from `CLAUDE_CONFIG_DIR` when set, otherwise the home directory's `.claude` folder. Placeholder tokens are not credentials. Sync fails closed and never falls back to SSH/SCP.

`ocx sync` also synchronizes an already-configured OpenCodex Desktop library, independently of the Codex configuration result. It does not initialize an unrelated Desktop profile or stop any running client. The writer uses Desktop's platform-specific `configLibrary` resolver, preserves other local profiles, refuses collisions with unregistered profile files, and protects backup and temporary files before writing credentials. Each file replacement is atomic; if metadata replacement fails, sync attempts to restore the original configuration and reports rollback failure separately. This is not a crash-atomic two-file transaction. Repeating an unchanged sync is a no-op. The main-only #349 hardening serializes apply and sync using a cross-process library lock, re-reads metadata inside that lock to preserve concurrent Desktop edits, keeps only the three newest secret-bearing pre-sync backups, and writes backups with private (0600) permissions. Tests exercise metadata races before and inside the locked write window; they do not prove behavior of an installed vendor Desktop build.

Running Desktop processes may retain their current picker until the application reloads its configuration. Existing sessions are not terminated automatically; choose when to reopen Desktop yourself. Codex's optional `--restart-codex` remains explicit and is not required for Desktop sync.

## Source, package and runtime evidence

The `doctor`, ownership, backup and lock changes above were merged on `main` in [#349](https://github.com/GroepOnline/opencodex/pull/349) **after** the [v1.5.5 release](https://github.com/GroepOnline/opencodex/releases/tag/v1.5.5). Use a build that contains #349 to rely on them. CLI source tests are not proof of actual XDG registration, running Desktop reload or an authenticated vendor request.
