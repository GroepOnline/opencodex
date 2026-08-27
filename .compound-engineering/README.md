# Compound Engineering overlay (opencodex)

This directory is the **repo overlay**. When it exists, CE uses these files
instead of native Cursor plugin defaults.

| File | Role |
| --- | --- |
| `config.yaml` | Tracked. CE reads `docs_root` from here. |
| `config.local.yaml` | Gitignored live settings. |
| `config.local.example.yaml` | Upstream template. |
| `artifacts/` | CE plans/solutions/ideation. Not operator `docs/`. |

Portable skills: `~/.agents/skills/ce-*` plus `lfg`, routed by
`compound-engineering-meta`. Native plugin remains fallback for checkouts
without this directory. This workspace disables the plugin in
`.cursor/settings.json`.
