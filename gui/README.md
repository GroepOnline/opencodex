# opencodex dashboard

This is the Vite/React dashboard used by `ocx gui` in packaged installs.

## Source checkout development

For the complete dashboard + API preview, run one process from the repo root:

```bash
bun run dev:preview
```

The launcher keeps the proxy on an internal loopback port and exposes the Vite dashboard on
Freebuff's injected `PORT`. `/api/*` and `/healthz` are proxied to the same internal runtime.
For split local development, the two-process setup remains available:

```bash
# terminal 1, repo root
bun run dev:proxy

# terminal 2, repo root
bun run dev:gui
```

The root proxy dev server exposes API endpoints such as `/healthz`, `/v1/responses`,
and `/api/*`. It serves `GET /` only when a packaged dashboard build exists at
`gui/dist`, so a fresh clone should use the Vite dev server while editing the UI.

## Build

From the repo root:

```bash
bun run build:gui
```

That command installs/builds this dashboard and copies the production assets into
the package layout used by `ocx gui`.

## Lint and React Doctor

```bash
cd gui
bun run lint         # ESLint — hard local/CI gate (`GUI lint` in CI)
bun run doctor       # React Doctor vs origin/main (changed-scope, gates on findings)
bun run doctor:full  # Full-tree React Doctor (gates on findings)
```

From the repo root:

```bash
bun run doctor:gui              # same as gui doctor
bun run doctor:gui:full
bun install                      # installs Husky hooks via prepare
```

| Tool                                | Role                                                                                                                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ESLint** (`bun run lint`)         | Hard gate in CI and expected before merge                                                                                                                                                          |
| **React Doctor** (`bun run doctor`) | Gating React health check pinned to react-doctor 0.9.2 (`blocking: warning`). Pre-push runs it only if `gui/` changed and fails the push on findings. The CI workflow fails the job on any finding |

Fix ESLint errors first. Use `doctor` / `doctor:full` for deeper React triage.

## Official shadcn registry & MCP (Signaal component work)

The repository root [`.mcp.json`](../.mcp.json) starts the **official** shadcn MCP server through `gui/scripts/shadcn-mcp.sh`. The wrapper switches to `gui/` before starting `shadcn@4.21.4 mcp`. This matters because `components.json` lives under `gui/`; the registry MCP resolves configuration from the process working directory. No separate registry server or production dependency is introduced.

Claude Code can load the shared root `.mcp.json` when the repository is the project root. Restart the client and verify a connected `shadcn` tool via `/mcp`; the committed files alone are **not** proof that a client is connected. Other clients, including Codex/OCX and OpenCode, require their own MCP configuration. Do **not** overwrite `~/.codex/config.toml`, existing `model_provider=\"ocx\"` routing or other client settings to activate this server. For Codex, use an additive `[mcp_servers.shadcn]` entry pointing at the absolute path of `gui/scripts/shadcn-mcp.sh` after checking for an existing shadcn MCP entry.

Registry operations are source-code reviews, not theme generators. Keep `base-nova`, Base UI and `src/components/primitives` as the canonical primitive owners. Before adopting a component, review `npx shadcn@4.21.4 info`, `docs COMPONENT`, `add COMPONENT --dry-run` and `add COMPONENT --diff` **from gui/**, inspect licenses/transitive packages, and make isolated commits. Do not run `init`, `apply` or `--overwrite` against our Signaal tokens or existing authored controls. The official registry needs no custom registry URL. Update the pinned CLI only with an explicit review and CI after upstream versions change.

References: [shadcn MCP](https://ui.shadcn.com/docs/mcp), [shadcn CLI](https://ui.shadcn.com/docs/cli), [OpenCodex GUI vNext RFC](https://app.notion.com/p/3f87107ffb2381eaac24cfd72c05cdc5).
