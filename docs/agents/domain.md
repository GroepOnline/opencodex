# Domain documentation

## Layout

This repository uses a **single-context** domain layout:

- `CONTEXT.md` — the root domain and product context document.
- `docs/adr/` — architecture decision records.
- `docs/agents/` — agent-consumption rules for repository workflows; this directory does not replace the domain context or ADRs.

There is no `CONTEXT-MAP.md` because the repository is not organized as multiple independently governed contexts.

## Consumer rules

Before making a change:

1. Read `CONTEXT.md` when it exists and use it as the source of domain terminology, boundaries, actors, invariants, and important workflows.
2. Read ADRs in `docs/adr/` that are relevant to the subsystem being changed.
3. Treat accepted ADRs as constraints unless the change explicitly revisits the decision.
4. When a change introduces a significant architectural decision, add a new numbered ADR under `docs/adr/` rather than rewriting historical decisions.
5. Keep `CONTEXT.md` focused on durable domain facts; put implementation details in the relevant source documentation.
6. Keep `docs/agents/*.md` focused on agent workflow configuration and consumer instructions.

`CONTEXT.md` is not present yet in this checkout. Create or update it when the repository's durable domain model is formally documented.
