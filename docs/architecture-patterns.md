# Architecture Patterns - LiteLLM Lessons

**Date:** 2026-10-10  
**Source:** LiteLLM (BerriAI/litellm) analysis via DeepWiki  
**Focus:** Cross-project patterns applicable to OpenCodex  
**Vision:** OpenCodex should evolve into a full multi-tenant AI gateway like LiteLLM

## Overview

LiteLLM is a mature AI gateway with 60.8k GitHub stars and production adoption at Netflix, Stripe, Google, and others. This document extracts architectural patterns from LiteLLM that can improve OpenCodex's design as it evolves from a local development proxy to a full multi-tenant AI gateway.

**Strategic alignment:** OpenCodex's long-term vision is to become a comprehensive LLM gateway that can be deployed as a service, not just a local development tool. This makes LiteLLM's enterprise patterns highly relevant, even if current OpenCodex is simpler.

## Key Architectural Patterns from LiteLLM

### 1. Config-Based Provider Registration

**LiteLLM pattern:** Each provider has a `Config` class with `transform_request()` and `transform_response()` methods. This centralizes request/response translation in one place per provider, avoiding scattered logic.

**OpenCodex equivalent:** Provider adapters in `src/adapters/` have similar responsibility but with less structure.

**Applicability:** High

**Implementation for OpenCodex:**

```typescript
// src/adapters/base-provider-config.ts
export abstract class BaseProviderConfig {
  abstract transformRequest(request: OcxRequest): ProviderRequest;
  abstract transformResponse(response: ProviderResponse): OcxResponse;
}

// src/adapters/anthropic/config.ts
export class AnthropicConfig extends BaseProviderConfig {
  transformRequest(request: OcxRequest): AnthropicRequest { ... }
  transformResponse(response: AnthropicResponse): OcxResponse { ... }
}
```

**Benefits:**

- Clear contract per provider
- Easy to add new providers
- Request/response logic co-located
- Testable through simple interface

**Non-applicable:** LiteLLM uses JSON-based config for OpenAI-like providers (2-5 lines JSON). OpenCodex doesn't need this - TypeScript is already structured.

---

### 2. Centralized HTTP Handler

**LiteLLM pattern:** `BaseLLMHTTPHandler` orchestrates calls to `transform_request()` and `transform_response()`, keeping HTTP handling generic and provider-agnostic.

**OpenCodex equivalent:** `src/bridge.ts` and adapter-specific HTTP logic scattered across adapters.

**Applicability:** High

**Implementation for OpenCodex:**

```typescript
// src/adapters/http-handler.ts
export class ProviderHttpHandler {
  async execute<T>(
    config: BaseProviderConfig,
    request: OcxRequest,
    options: HttpOptions,
  ): Promise<T> {
    const providerRequest = config.transformRequest(request);
    const response = await this.httpFetch(providerRequest, options);
    return config.transformResponse(response);
  }
}
```

**Benefits:**

- Reusable HTTP logic (retries, timeouts, error classification)
- Providers only need transform methods
- Consistent behavior across all adapters

**Non-applicable:** LiteLLM's HTTP handler is more complex (supports async generators, streaming). OpenCodex's simpler streaming model doesn't need full parity.

---

### 3. Tool Catalog Normalization

**LiteLLM pattern:** Standard web search tool definition (`litellm_web_search`) with provider-specific format conversion. Provider-native tool definitions (e.g., Anthropic's `web_search_20250305`) are converted to standard format before sending to provider.

**OpenCodex equivalent:** Tool logic scattered across `tool-definitions.ts`, `request-builder.ts`, `protobuf-request.ts`, `arg-codec.ts`, `arg-normalize.ts`.

**Applicability:** Very High - directly addresses cursor adapter friction

**Implementation for OpenCodex:**

```typescript
// src/adapters/cursor/tool-catalog.ts
export class CursorToolCatalog {
  // Single source of truth for tool definitions
  private tools: Map<string, ToolDefinition>;

  normalizeTool(tool: ProviderTool): StandardTool {
    // Convert provider-specific to standard format
  }

  applyBudget(tools: StandardTool[], budget: ToolBudget): StandardTool[] {
    // Centralized budgeting logic
  }

  encodeSchema(schema: object): Uint8Array {
    // Centralized protobuf encoding
  }
}
```

**Benefits:**

- Tool logic in one place (high locality)
- Easy to add new tool types
- Consistent budgeting across tool calls
- Clear interface for testing

**Non-applicable:** LiteLLM's tool system is more complex (MCP gateway, server-side interception). OpenCodex needs simpler catalog normalization.

---

### 4. Budget and Spend Tracking Integration

**LiteLLM pattern:** Cost tracking integrated into request/response pipeline. Tool costs aggregated in `server_tool_use` within Usage object. Global tool registry (`LiteLLM_ToolTable`) for tracking.

**OpenCodex equivalent:** Usage tracking in `usage.jsonl` but no tool-specific cost tracking.

**Applicability:** Medium - useful for observability but not critical

**Implementation for OpenCodex:**

```typescript
// src/usage/tool-tracker.ts
export class ToolUsageTracker {
  trackToolCall(toolName: string, cost: number): void {
    // Enqueue for upsert into tool registry
  }

  getToolCosts(): Map<string, number> {
    // Return aggregated tool costs
  }
}
```

**Benefits:**

- Better cost visibility
- Tool usage analytics
- Identifies expensive tool patterns

**Non-applicable:** LiteLLM has enterprise spend tracking with database backend. OpenCodex's local `usage.jsonl` doesn't need full parity.

---

### 5. Health Check Separation

**LiteLLM pattern:** Health checks separate from provider logic. Dedicated health monitoring with model-specific uptime tracking.

**OpenCodex equivalent:** Health checks mixed with CLI display formatting in `oauth/health.ts`.

**Applicability:** High - already identified in architecture review

**Implementation for OpenCodex:**

```typescript
// src/health/projection.ts
export class HealthProjection {
  projectOAuthAccountHealth(account: OAuthAccount): HealthStatus {
    // Pure logic, no display concerns
  }
}

// src/health/display.ts
export class HealthDisplay {
  formatHealthLabel(status: HealthStatus): string {
    // CLI-specific formatting
  }
}
```

**Benefits:**

- Health logic reusable across CLI, GUI, API
- Easier to test projection logic
- Clear separation of concerns

**Non-applicable:** LiteLLM's health system is more complex (multi-database, enterprise monitoring). OpenCodex needs simpler projection/display split.

---

### 6. Request Lifecycle Orchestration

**LiteLLM pattern:** Clear stages: User Query → Prompt Factory → Provider Adapters → LLM APIs → Response. Each stage has well-defined responsibility.

**OpenCodex equivalent:** Request lifecycle documented in `structure/` but not explicitly staged in code.

**Applicability:** Medium - helpful for clarity but may require refactoring

**Implementation for OpenCodex:**

```typescript
// src/server/lifecycle/request-pipeline.ts
export class RequestPipeline {
  async execute(request: IncomingRequest): Promise<OutgoingResponse> {
    const parsed = await this.parseRequest(request);
    const routed = await this.route(parsed);
    const adapted = await this.adapt(routed);
    const upstream = await this.fetch(adapted);
    const projected = await this.project(upstream);
    return projected;
  }
}
```

**Benefits:**

- Clear request flow
- Easy to add middleware (logging, validation)
- Easier debugging

**Non-applicable:** OpenCodex's Bun runtime is simpler than LiteLLM's Python/Rust hybrid. Full pipeline orchestration may be overkill.

---

## Patterns for Future Multi-Tenant Evolution

These patterns are applicable for OpenCodex's long-term vision as a multi-tenant gateway, but not needed for current local proxy use.

### 1. Database-Backed Configuration

**LiteLLM:** Uses database for configuration, user management, spend tracking (PostgreSQL, etc.).

**OpenCodex (current):** Uses local JSON config (`~/.opencodex/config.json`).

**OpenCodex (future):** Should support database backend for multi-tenant deployments.

**Migration path:**

- Phase 1: Keep JSON config as primary, add database read support (optional)
- Phase 2: Database becomes primary, JSON for backup/local dev
- Phase 3: Full database with JSON import/export

**Recommended database:** PostgreSQL (LiteLLM's choice) or Neon (serverless PostgreSQL for easier deployment)

---

### 2. Enterprise Multi-Tenancy & Authentication Strategy

**LiteLLM:** Teams, organizations, SCIM, SSO, API key management with RBAC.

**OpenCodex (current):** Single-user local proxy with optional remote dashboard access (Cloudflare Access, Authentik OIDC).

**OpenCodex (future):** Should support teams, organizations, ChefGroep identity, and additional auth providers (Clerk, WorkOS) with proper RBAC.

#### Current Authentication Layer

OpenCodex already has a solid authentication foundation:

**Cloudflare Access**

- Protects remote dashboard access
- Zero-trust network access
- Works with Cloudflare Tunnel deployments
- No auth file needed for protected routes

**Authentik OIDC**

- Browser identity enforcement for dashboard
- OAuth login flow (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET_FILE`)
- ID token verification
- Configurable redirect URI

**API Keys**

- Data-plane authentication (`OPENCODEX_API_AUTH_TOKEN`, `config.apiKeys`)
- Management-plane authentication (`OPENCODEX_ADMIN_AUTH_TOKEN`, `admin-api-token` file)
- Constant-time token comparison to prevent timing attacks
- Virtual key generation and management via dashboard

#### ChefGroep Identity Provider

**Status:** Configurable via OIDC (planned)

**Architectural principle:** ChefGroep auth and identity management is configured via OIDC provider configuration in OpenCodex's config. OpenCodex provides the auth integration layer; the ChefGroep identity provider is external and configured through standard OIDC endpoints.

**Integration approach:**

OpenCodex already has OIDC support (Authentik). ChefGroep is added as another OIDC provider via configuration:

```typescript
// Config schema
interface OidcProvider {
  name: string; // "chefgroep", "authentik", "clerk", etc.
  issuer: string; // OIDC issuer URL
  clientId: string;
  clientSecretFile: string; // Path to secret file (not in repo)
  redirectUri: string;
  scope?: string[];
}
```

**Current state:**

- ChefGroep appears only in documentation and test references (not in source code)
- No ChefGroep auth integration exists in `src/`
- Current auth uses Cloudflare Access + Authentik OIDC
- OpenCodex already has OIDC infrastructure

**Recommended implementation:**

1. Add ChefGroep OIDC provider configuration to config schema
2. ChefGroep provides OIDC issuer URL, client ID, and client secret
3. OpenCodex uses existing OIDC flow for ChefGroep (same as Authentik)
4. Client secret stored in secret file (not in repo)
5. OpenCodex validates ChefGroep ID tokens via standard OIDC verification

**Migration path:**

- Phase 1: Keep current auth (Cloudflare Access + Authentik OIDC) as external auth
- Phase 2: Add ChefGroep OIDC provider to config schema
- Phase 3: ChefGroep provides OIDC endpoints and credentials
- Phase 4: Add ChefGroep to auth provider priority list
- Phase 5: Use ChefGroep OIDC for internal GroepOnline operations

#### Customer-Facing Auth Providers

**Clerk**

- Purpose: Customer-facing authentication for OpenCodex as a SaaS product
- Features: User registration, email verification, MFA, social logins, organization management
- Integration: Clerk SDK for TypeScript, or Clerk's auth middleware
- Use case: When OpenCodex is sold as a hosted service with web-based signup

**WorkOS**

- Purpose: Enterprise SSO for enterprise customers
- Features: SAML, SCIM, Just-in-Time provisioning, audit logs
- Integration: WorkOS API for SAML assertion validation, SCIM sync
- Use case: Enterprise customers that require SAML SSO with their IdP (Okta, Azure AD, etc.)

#### Multi-Provider Auth Strategy

OpenCodex should support multiple auth providers simultaneously:

```typescript
// Auth provider configuration
interface AuthProvider {
  type: "cloudflare-access" | "oidc";
  name?: string; // "authentik", "chefgroep", "clerk", etc. for OIDC
  priority: number; // Try providers in order
  scope: "dashboard" | "api" | "cli" | "all";
}

// Example config
authProviders: [
  { type: "cloudflare-access", priority: 1, scope: "dashboard" },
  { type: "oidc", name: "authentik", priority: 2, scope: "dashboard" },
  { type: "oidc", name: "chefgroep", priority: 1, scope: "api" }, // Internal services
  { type: "oidc", name: "clerk", priority: 1, scope: "dashboard" }, // Customer auth
  { type: "oidc", name: "workos", priority: 2, scope: "dashboard" }, // Enterprise SSO
];
```

**Migration path:**

- Phase 1: Keep current auth (Cloudflare Access + Authentik OIDC)
- Phase 2: Add team/organization concepts in management API
- Phase 3: Implement RBAC with per-team API keys
- Phase 4: Add ChefGroep OIDC provider to config schema
- Phase 5: Add Clerk OIDC provider to config schema (optional, SaaS path)
- Phase 6: Add WorkOS OIDC provider to config schema (optional, enterprise path)
- Phase 7: Add SCIM/SSO integration for enterprise customers

**Implementation notes:**

- Leverage existing Cloudflare Access and Authentik OIDC integration as foundation
- Model after LiteLLM's database schema for teams/users/organizations
- Keep local proxy mode as "single-tenant" variant
- Support auth provider configuration per deployment type (local vs hosted)
- All OIDC providers (ChefGroep, Clerk, WorkOS) use the same OIDC flow - just different endpoints
- Clerk/WorkOS are optional - only needed for SaaS/enterprise deployment

---

### 3. Proxy Server as Separate Component

**LiteLLM:** Gateway, backend, and UI can be deployed separately (componentized deployment).

**OpenCodex (current):** Single monolithic proxy that serves GUI.

**OpenCodex (future):** Should support componentized deployment for scalability.

**Migration path:**

- Phase 1: Keep monolithic (current)
- Phase 2: Separate GUI as static asset service (CDN)
- Phase 3: Separate stateless gateway layer (horizontal scaling)
- Phase 4: Separate backend for management/observability

**Benefits:**

- Horizontal scaling of gateway layer
- Independent UI updates
- Separate resource isolation

---

### 4. Rust Performance Layer

**LiteLLM:** Rust core for performance-critical components (inference messages, shared types).

**OpenCodex (current):** Bun-native TypeScript.

**OpenCodex (future):** Consider Rust for hot path if performance becomes bottleneck.

**Evaluation criteria:**

- Measure Bun performance at scale (1000+ RPS)
- If P95 latency > 50ms, consider Rust for request parsing/streaming
- Only implement if clear performance benefit justifies complexity

**Recommendation:** Defer until actual performance bottleneck is measured. Bun may be sufficient.

---

## Recommended Changes to OpenCodex

### Immediate (High Impact, Low Complexity)

1. **Apply Config-Based Provider Pattern** - Create `BaseProviderConfig` with `transformRequest/transformResponse`. This simplifies adding new providers and centralizes adapter logic.

2. **Separate Health Projection from Display** - Already in architecture review. Simple split with high reuse value.

3. **Create Centralized HTTP Handler** - Extract common HTTP logic (retries, error classification) into reusable handler.

### Short-Term (Medium Impact, Medium Complexity)

4. **Consolidate Tool Catalog** - Create `CursorToolCatalog` class. This addresses cursor adapter friction with high locality benefit.

5. **Add Tool Usage Tracking** - Simple tool cost tracking for observability. Not critical but useful.

### Long-Term (High Impact, High Complexity)

6. **Request Lifecycle Pipeline** - Explicit staging of request processing. Improves clarity and debugging but requires significant refactoring.

## Summary

| Pattern                              | Applicability         | Priority   | Complexity | Notes                                                                                  |
| ------------------------------------ | --------------------- | ---------- | ---------- | -------------------------------------------------------------------------------------- |
| Config-based provider registration   | High                  | Immediate  | Low        | Core architecture improvement                                                          |
| Centralized HTTP handler             | High                  | Immediate  | Low        | Reusable HTTP logic                                                                    |
| Tool catalog normalization           | Very High             | Short-term | Medium     | High locality benefit                                                                  |
| Health check separation              | High                  | Immediate  | Low        | Simple split, high reuse                                                               |
| Budget/spend tracking                | Medium                | Short-term | Low        | Observability improvement                                                              |
| Request lifecycle orchestration      | Medium                | Long-term  | High       | Clarity vs complexity tradeoff                                                         |
| Database-backed config               | Future (multi-tenant) | Phase 2-3  | Medium     | PostgreSQL/Neon for scaling                                                            |
| Multi-provider auth strategy         | Future (multi-tenant) | Phase 2-7  | High       | ChefGroep OIDC (config) + Clerk OIDC (customers) + WorkOS OIDC (enterprise) + SCIM/SSO |
| Componentized deployment             | Future (multi-tenant) | Phase 2-4  | Medium     | Gateway/UI/backend separation                                                          |
| Rust performance layer               | Future (performance)  | Defer      | High       | Only if measured bottleneck                                                            |
| Client-side agents (IDE integration) | Future (multi-tenant) | Phase 3-4  | Medium     | Claude Desktop + Codex shim enhancement                                                |

## Preserving Local Integration Features in Multi-Tenant Architecture

OpenCodex has critical local integration features that must be preserved as it evolves to multi-tenant:

- **Claude Desktop injection** - Writes JSON profile files to Claude Desktop's 3p config library (`src/claude/desktop-3p.ts`)
- **Codex integration** - Injects config into `$CODEX_HOME/config.toml` and syncs model catalog
- **Native OpenAI passthrough** - Redirects Codex's `openai` provider through proxy

### The Problem: File-Based Operations vs Multi-Tenancy

Current implementations are **file-based local operations**:

- Claude Desktop: `writeDesktop3pConfig` writes to local filesystem
- Codex: Direct modification of `$CODEX_HOME/config.toml`
- Both are single-user, per-machine operations

In a multi-tenant setting (multiple users on one OpenCodex instance), these file writes would conflict.

### Solution: Dual-Mode Architecture

OpenCodex should support two deployment modes with preserved functionality:

#### Mode 1: Local Mode (Current Behavior)

- **Use case:** Personal development, single-user local proxy
- **Behavior:** File-based injection to Claude Desktop and Codex
- **Authentication:** Loopback-only, no auth needed
- **Configuration:** JSON config file
- **Preserves:** All current local integration features

#### Mode 2: Remote/Multi-Tenant Mode (New)

- **Use case:** Team deployment, shared gateway, enterprise
- **Behavior:** API-based configuration, no local file writes
- **Authentication:** Cloudflare Access, Authentik OIDC, API keys
- **Configuration:** Database-backed
- **New mechanism:** User downloads configuration profiles or uses client-side agents

### Preserving Claude Desktop Integration in Multi-Tenant Mode

**Challenge:** Claude Desktop expects local file-based 3p config.

**Solution options:**

**Option A: Client-Side Agent (Recommended)**

- Provide a CLI tool (`ocx claude-desktop configure`) that:
  1. Fetches user's configuration from OpenCodex API (authenticated)
  2. Writes local 3p config files on user's machine
  3. User runs this on their laptop, not on the gateway
- Similar to how VPN clients work - agent runs locally, connects to remote gateway

**Option B: Profile Download**

- Dashboard provides "Download Claude Desktop Profile" button
- User downloads JSON profile
- Manual or automated placement in Claude Desktop config directory
- Requires user action but preserves security boundary

**Option C: SSH Tunnel**

- OpenCodex agent runs on user's laptop (via SSH tunnel to gateway)
- Agent listens for config updates from gateway
- Writes local files when configuration changes
- More complex but real-time

**Recommendation:** Start with Option A (CLI tool), add Option B (profile download) for non-technical users. Option C only if real-time sync is needed.

### Preserving Codex Integration in Multi-Tenant Mode

**Challenge:** Codex expects local `$CODEX_HOME/config.toml` injection.

**Solution options:**

**Option A: Codex Shim Agent (Recommended)**

- Similar to current `ocx codex-shim install` but:
  1. Shim connects to remote OpenCodex instance via API
  2. Fetches user's configuration (models, providers, routing)
  3. Writes local `$CODEX_HOME/config.toml` with user's settings
  4. Handles sync/restore from remote gateway
- User runs shim on their laptop, gateway is remote

**Option B: Remote Desktop Mode**

- Codex can connect to remote OpenCodex instance via API
- No local config injection needed
- Requires Codex client support (check if available)

**Option C: Hybrid Mode**

- Local config for offline work
- Remote gateway sync when available
- More complex but best of both worlds

**Recommendation:** Start with Option A (enhanced shim), investigate Option B if Codex supports remote configuration natively.

### Implementation Strategy

**Phase 1: Preserve Local Mode**

- Keep all current file-based injection logic
- Ensure local mode works unchanged
- Add mode flag to config: `deploymentMode: "local" | "remote"`

**Phase 2: Add Remote Mode Foundation**

- Add database-backed configuration
- Add user/team/organization concepts
- Add API endpoints for configuration fetch
- Keep file-based logic disabled in remote mode

**Phase 3: Add Client-Side Agents**

- Implement `ocx claude-desktop configure` CLI tool
- Enhance `ocx codex-shim` for remote gateway connection
- Add profile download endpoints in dashboard
- Test with remote OpenCodex instance

**Phase 4: Add ChefGroep OIDC Integration**

- Add ChefGroep OIDC provider to config schema
- ChefGroep provides OIDC issuer URL and credentials
- OpenCodex uses existing OIDC flow for ChefGroep
- Client secret stored in secret file (not in repo)

**Phase 5: Add Real-Time Sync (Optional)**

- SSH tunnel agent for Claude Desktop
- Real-time config sync for Codex shim
- Webhook-based updates

### LiteLLM Comparison

LiteLLM doesn't have this problem because:

- LiteLLM is a pure gateway, no local client integration
- Clients call via HTTP API, no file-based configuration
- Enterprise features are API-based from the start

OpenCodex's unique value is **local IDE integration**. This requires a different approach than LiteLLM's pure gateway model.

### Summary

| Feature                   | Current Implementation             | Multi-Tenant Challenge            | Solution                                                                                             |
| ------------------------- | ---------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Claude Desktop injection  | File-based local writes            | Multiple users → file conflicts   | Client-side CLI tool or profile download                                                             |
| Codex integration         | File-based $CODEX_HOME injection   | Multiple users → config conflicts | Enhanced shim with remote gateway sync                                                               |
| Native OpenAI passthrough | Local config redirect              | Already works via proxy routing   | No change needed (API-based)                                                                         |
| Authentication            | Cloudflare Access + Authentik OIDC | Need multi-provider support       | Multi-provider strategy: ChefGroep OIDC (config) + Clerk OIDC (customers) + WorkOS OIDC (enterprise) |

**Key insight:** OpenCodex should evolve to a **hybrid architecture** - remote gateway for multi-tenant scaling, but with client-side agents that preserve local IDE integration. This is different from LiteLLM's pure gateway model and is a key differentiator.

**Auth strategy:** OpenCodex will support multiple auth providers simultaneously - ChefGroep OIDC (configured via config) for internal operations, Cloudflare Access/Authentik for current deployments, and optionally Clerk (customer-facing) and WorkOS (enterprise SSO) for multi-tenant SaaS paths.

**Evolution roadmap:** Current local proxy → single-tenant gateway with ChefGroep OIDC auth (configured via config) → multi-tenant enterprise gateway with multi-provider OIDC auth (Clerk/WorkOS) and client-side agents for IDE integration.
