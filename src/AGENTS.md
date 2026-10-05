# Source runtime instructions

This file applies to `src/` and inherits the repository-wide rules in `/AGENTS.md`.

## Runtime and module rules

- `src/` is Bun-native TypeScript in strict mode and uses ES modules only.
- Do not assume a separate server compilation step.
- Prefer Bun and Web-platform APIs. Introduce a Node-only runtime dependency only when the task explicitly requires compatibility code and the owning module already has that role.
- Preserve existing public exports and configuration compatibility unless the task explicitly changes them.
- Read the applicable documents in `structure/` before changing shared routing, adapters, transports, sidecars, authentication, configuration, or server architecture.

## Implementation rules

- Follow the existing subsystem boundaries and naming patterns.
- Do not combine unrelated responsibilities to avoid creating another large shared module.
- Handle asynchronous failures at request, transport, and sidecar boundaries. Optional integrations must degrade through the existing failure representation rather than crash the request path.
- Provider catalog metadata belongs in the canonical provider registry and derivation flow. Do not duplicate provider facts across independent pickers or seeds.
- Adapter changes must preserve the internal event contract, streaming behavior, tool calls, cancellation, error mapping, and image handling relevant to that adapter.
- Authentication, OAuth, token, credential, management API, and CORS changes are security-boundary changes.

## Codex native coexistence

For Codex integration work, the loopback path is additive: keep the built-in `openai` provider
identity and ordinary ChatGPT/Codex auth, and let OCX own only the managed proxy transport plus the
canonical merged catalog at `$CODEX_HOME/opencodex-catalog.json`.

Do not introduce alternate "native + OCX" catalog files or preserve a competing root
`model_catalog_json` while OCX owns routing. Native bare OpenAI rows are authoritative live rows;
preserve their capability fields unchanged so newly rolled-out models do not fall back to generic
Codex metadata. When no managed catalog is available, or the selected bare native GPT/Codex slug is
absent from it, remove the managed root catalog override and let native Codex metadata win.
Restore/eject must recover the user's pre-OCX config through the journal.

## Tests and validation

- Place focused regression coverage near the existing tests for the affected subsystem.
- For focused behavior, run the relevant `bun test tests/<name>.test.ts` and `bun run typecheck`.
- For shared routing, adapters, config, OAuth, or server behavior, also run `bun run test`.
- For logging, requests, credentials, account data, or fixtures, also run `bun run privacy:scan`.
- Update `docs-site/` when the change affects user-visible behavior or configuration.