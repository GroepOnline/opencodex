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
```

Install registers the exact `ocx-desktop://sync` action for the current user. OCX records versioned file ownership and refuses foreign files or symlinks instead of replacing them. Package updates repair an already-owned handler through the newly installed CLI; they never install one automatically. Status verifies the owned files, not which application is currently the MIME default. Uninstall removes only proven-owned files and leaves shared MIME settings intact.

An older, unversioned helper is not adopted automatically. If installation reports foreign files, keep using `ocx claude desktop sync` until those files have been reviewed and migrated. Runtime executable paths containing `=` or `%` cannot be registered because Linux Desktop/GIO cannot launch them reliably.

## Authentication

The data-plane library endpoint is `GET /v1/claude-desktop-3p-library`. It requires a data-plane admission secret even on loopback, with the same origin policy as other data-plane routes. The dashboard management route `GET /api/claude-desktop/3p-library` uses management authentication (admin token, GUI session, or Cloudflare Access) instead.

## Secret handling

The response is the applied 3P library and may contain `inferenceGatewayApiKey`. Treat it as a secret: use HTTPS or a protected local tunnel, do not log the response, and do not share the sync URL or response contents.

## Workflow

1. Edit the Claude Desktop profile in the dashboard.
2. Select **Save & Apply** and wait for confirmation on the proxy.
3. Run `ocx claude desktop sync` to copy the applied library through the configured Claude Code loopback gateway. The command uses the existing data-plane token resolver (`OPENCODEX_API_AUTH_TOKEN`, `OCX_API_TOKEN_FILE`, or the service-token file), an explicit client credential, or the existing `apiKeyHelper`. Placeholder tokens are not credentials. Sync fails closed and never falls back to SSH/SCP.

`ocx sync` also synchronizes an already-configured OpenCodex Desktop library, independently of the Codex configuration result. It does not initialize an unrelated Desktop profile or stop any running client. The writer uses Desktop's platform-specific `configLibrary` resolver, preserves other local profiles, refuses collisions with unregistered profile files, and protects backup and temporary files before writing credentials. Each file replacement is atomic; if metadata replacement fails, sync attempts to restore the original configuration and reports rollback failure separately. This is not a crash-atomic two-file transaction. Repeating an unchanged sync is a no-op.

Running Desktop processes may retain their current picker until the application reloads its configuration. Existing sessions are not terminated automatically; choose when to reopen Desktop yourself. Codex's optional `--restart-codex` remains explicit and is not required for Desktop sync.
