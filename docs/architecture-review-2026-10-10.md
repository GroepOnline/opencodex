# Architecture Review - October 2026

**Date:** 2026-10-10  
**Scope:** Recent hot spots from git log (health consolidation, GUI redesign, CLI management API)  
**Focus:** Shallow modules, locality issues, and deepening opportunities  
**Vision:** Preparing OpenCodex for evolution into a multi-tenant AI gateway

## Executive Summary

This review identifies architectural friction across four subsystems:

1. **CLI Management API Surface** (High priority) - Utility kitchen sink, monolithic route handlers. Critical for multi-tenant readiness.
2. **Health Checks and Provider Readiness** (High priority) - Mixed runtime/display concerns. Important for multi-tenant observability.
3. **Cursor Adapter Subsystem** (Medium priority) - 32 files, scattered tool logic. Important for enterprise IDE integrations.
4. **GUI Design Token System** (Speculative) - Thin wrapper, split TypeScript/CSS reality.

**Top recommendation:** Start with CLI Management API and Health Checks consolidations. These are foundational for multi-tenant deployment. Cursor adapter consolidation becomes more important as OpenCodex targets enterprise IDE use cases.

## Architecture Vocabulary

These terms form the shared language for discussing architectural improvements:

- **Module**: A cohesive unit of code with a single responsibility. A good module hides complexity behind a simple interface.
- **Interface**: The public contract a module exposes. The interface is the test surface.
- **Depth**: How much complexity a module hides behind its interface. Deep modules have simple interfaces that hide rich implementation.
- **Seam**: A boundary where you can swap implementations. A real seam has a testable interface; a hypothetical seam doesn't.
- **Adapter**: Translates between two interfaces. One adapter = hypothetical seam, two = real seam.
- **Leverage**: How much a module reduces complexity elsewhere. High leverage means one deep module replaces many shallow ones.
- **Locality**: How related concepts stay together. Good locality means understanding one concept doesn't require bouncing between many files.

**The Deletion Test:** Would deleting this module concentrate complexity or just move it? If deletion would require inlining the logic everywhere it's used, the module is shallow — it's plumbing, not an abstraction. A deep module passes the deletion test: removing it would concentrate complexity into a larger, less testable blob.

## Candidates

### 1. CLI Management API Surface

**Priority:** Worth exploring  
**Files:** `src/cli/runtime-api.ts` (325 lines), `src/server/management/provider-routes.ts` (678 lines), `src/server/management/shared.ts` (428 lines), `src/cli/provider.ts` (463 lines)  
**ADR context:** ADR-0007 mandates headless CLI parity through the management control plane.

#### Problem

`runtime-api.ts` is a "utility kitchen sink" - argument parsers, fetch wrappers, output formatters, and error handlers with no conceptual cohesion. Management route handlers are monolithic (678 lines) with mixed concerns: config validation, OAuth flow orchestration, quota fetching, model discovery, usage summarization, debug settings.

Understanding "how to add a new management endpoint" requires reading 4+ files. No clear pattern exists.

#### Solution

Split `runtime-api.ts` into focused modules:

- `cli-args.ts` - Argument parsing
- `cli-fetch.ts` - Fetch with headers
- `cli-output.ts` - Formatting

Extract route handler patterns into reusable utilities:

- `route-validator.ts` - Shared validation
- `route-formatter.ts` - Shared formatting

Break down monolithic route handlers into module-per-route-group structure. Document the management API contract separately.

#### Benefits

| Aspect          | Before                                              | After                                  |
| --------------- | --------------------------------------------------- | -------------------------------------- |
| Locality        | Utilities scattered in one file                     | Each module has single responsibility  |
| Duplication     | Validation/formatting repeated in 678-line handlers | Shared reusable utilities              |
| Leverage        | No reusable patterns                                | Route validator/formatter utilities    |
| AI-navigability | Requires reading 4+ files to add endpoint           | Clear contract documentation + pattern |

#### Migration Path

1. Create `cli-args.ts`, `cli-fetch.ts`, `cli-output.ts` from `runtime-api.ts`
2. Extract validation logic into `route-validator.ts`
3. Extract formatting logic into `route-formatter.ts`
4. Refactor `provider-routes.ts` to use new utilities
5. Write management API contract documentation
6. Deprecate old utility functions

---

### 2. Health Checks and Provider Readiness

**Priority:** Worth exploring  
**Files:** `src/oauth/health.ts` (504 lines), `src/server/proxy-liveness.ts` (220 lines)

#### Problem

`oauth/health.ts` mixes runtime health projection with CLI display formatting, violating locality. Two similar liveness functions (`findLiveProxy`, `findReachableProxyForCli`) differ only in timeout behavior. Projection functions are pure transformations extracted for testability without meaningful abstraction.

#### Solution

Split `oauth/health.ts` into:

- `health-projection.ts` - Pure logic
- `health-display.ts` - CLI formatting

Merge the two liveness functions into one with a `cliReachableMode` parameter. This creates a clear seam between health evaluation and display.

#### Benefits

| Aspect      | Before                             | After                                            |
| ----------- | ---------------------------------- | ------------------------------------------------ |
| Seam        | Runtime and display mixed          | Clear boundary between evaluation and formatting |
| Duplication | Two similar liveness functions     | One parameterized function                       |
| Leverage    | Health projection only used by CLI | Reusable across CLI, GUI, and API                |
| Testability | Tests hit display logic            | Tests can target pure projection logic directly  |

#### Migration Path

1. Extract projection functions into `health-projection.ts`
2. Extract display functions into `health-display.ts`
3. Merge `findLiveProxy` and `findReachableProxyForCli` into `findProxy(mode)`
4. Update all call sites
5. Add integration tests for projection logic

---

### 3. GUI Design Token System

**Priority:** Speculative  
**Files:** `gui/src/design-tokens.ts` (26 lines), `gui/src/styles.css`  
**ADR context:** ADR-0005 describes moving to CSS custom properties.

#### Problem

`design-tokens.ts` is a shallow module - a thin wrapper around a CSS class mapping function. The TypeScript module doesn't define the actual tokens; they live in CSS, creating a split between types and reality. Deleting it would just inline the trivial logic.

#### Solution Options

**Option A (YAGNI):** Inline the status class mapping. Remove the module entirely.

**Option B (Deepen):** Expand to a true design system manager that code-generates TypeScript types from CSS tokens.

#### Benefits

| Aspect          | Before       | After (Option A) | After (Option B)   |
| --------------- | ------------ | ---------------- | ------------------ |
| Source of truth | Split TS/CSS | CSS only         | CSS + generated TS |
| Type safety     | Manual sync  | N/A              | Automatic          |
| Complexity      | Thin wrapper | Removed          | Deep system        |

#### Recommendation

Start with Option A (inline) unless the design system expansion becomes necessary. ADR-0005 alignment is preserved in both options.

---

### 4. Cursor Adapter Subsystem

**Priority:** Medium (important for enterprise IDE integrations)  
**Files:** `src/adapters/cursor/` (32 files, 1,255+ exports)  
**Test files:** 32 dedicated test files

#### Problem

The cursor adapter has shallow modules with complex interfaces and poor locality. Tool-related logic leaks across 6+ files (`tool-definitions.ts`, `request-builder.ts`, `protobuf-request.ts`, `arg-codec.ts`, `arg-normalize.ts`). Native exec is over-split into 8 files with shallow orchestration. Policy logic exports 6 functions for a trivial ternary check.

Pure function over-extraction for testability: 32 test files suggest testing strategy issues.

#### Solution

Consolidate scattered concerns into cohesive modules:

- `cursor-tool-catalog.ts` - Tool discovery, budgeting, schema encoding, aliases
- `cursor-protobuf.ts` - Protobuf helpers, framing, codecs
- `cursor-native-exec.ts` - Native exec with internal organization
- Simplify `exec-policy.ts` to single export

#### Benefits

| Aspect          | Before                      | After                                  |
| --------------- | --------------------------- | -------------------------------------- |
| Locality        | Tool logic in 6+ files      | Single `cursor-tool-catalog.ts` module |
| Leverage        | 32 shallow files            | 3-4 deep modules                       |
| Testability     | 32 pure-function test files | Fewer integration tests                |
| AI-navigability | Requires reading 6+ files   | Single module entry point              |

#### Migration Path

1. Create `cursor-tool-catalog.ts` by merging tool discovery, budgeting, schema encoding
2. Create `cursor-protobuf.ts` by consolidating protobuf helpers
3. Collapse native exec files into `cursor-native-exec.ts`
4. Simplify `exec-policy.ts`
5. Write integration tests for new deep modules
6. Deprecate old shallow modules

#### Why Medium Priority

- Higher complexity than CLI/health consolidations
- Cursor adapter is specialized (one IDE client) but critical for enterprise IDE use cases
- 32 files suggest historical accumulation, but tool catalog consolidation is foundational for multi-tenant IDE support
- Important for enterprise IDE integrations (Cursor, JetBrains via plugins)

---

## Recommended Work Order

1. **CLI Management API** - Clear leverage, follows ADR-0007 principle, foundational for multi-tenant management API
2. **Health Checks** - Simple split, high reuse value, critical for multi-tenant observability
3. **Cursor Adapter** - Tool catalog consolidation is foundational for enterprise IDE integrations
4. **GUI Design Tokens** - Quick win (inline) or defer

## Summary Table

| Area           | Primary Friction                          | Deletion Test             | Interface vs Impl                                 | Priority    | Multi-tenant Relevance                  |
| -------------- | ----------------------------------------- | ------------------------- | ------------------------------------------------- | ----------- | --------------------------------------- |
| CLI management | Utility kitchen sink, monolithic handlers | Fails (would scatter)     | Interface simple for runtimeRequest, impl complex | High        | Critical - management API foundation    |
| Health checks  | Mixed runtime/display, duplicate liveness | Fails (would scatter)     | Interface complex for projection functions        | High        | Critical - observability foundation     |
| Cursor adapter | Over-extraction, scattered tool logic     | Fails (plumbing)          | Interface ≈ Implementation for policy/framing     | Medium      | Important - enterprise IDE integrations |
| GUI tokens     | Thin wrapper, split TS/CSS                | Fails (trivial to inline) | Interface simple, impl trivial                    | Speculative | Low - UI polish only                    |

## Next Steps

1. **Immediate:** Implement CLI Management API and Health Check consolidations. These are foundational for multi-tenant deployment.
2. **Short-term:** Consolidate cursor adapter tool catalog. This becomes increasingly important as OpenCodex targets enterprise IDE integrations.
3. **Medium-term:** Design database schema for multi-tenant configuration (see `architecture-patterns.md` for migration path).
4. **Long-term:** Evaluate componentized deployment (gateway/UI/backend separation) as scale requirements emerge.

See `architecture-patterns.md` for detailed LiteLLM lessons and multi-tenant evolution roadmap.
