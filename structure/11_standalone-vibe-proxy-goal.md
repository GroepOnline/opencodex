# 11 — Standalone "Vibe Proxy" Goal (GroepOnline opencodex)

Status: **GOAL DOCUMENT** — geautoriseerd door Joep (2026-08-21, "akkoord en door").
Bouwt voort op `structure/09_x10-terminal-plan.md`. Target branch: `feat/availability-module`
(daarop verder, of nieuwe `feat/standalone-vibe-proxy` vanaf die head).

## Waarom

opencodex is historisch ge-groeid rond **OpenAI Codex**: ChatGPT account-pools, 5h/weekly/30d
quota-windows, Codex history-remapping, en een availability-module (`src/availability/`) die
vooral Codex-account-pools + OAuth-pools kent. Joep wil de proxy ombouwen tot een **standalone
"vibe proxy"** die:

1. Niet meer afhankelijk is van Codex als default-flow — Codex-subagents/pools worden een opt-in module.
2. **Claude Code + Claude Desktop/Cowork** als first-class citizens behandelt.
3. Echt **inzicht geeft in gebruik + provider-usage** (niet alleen wat we zelf bijhouden).
4. **Per-provider key-pooling** robuust doet (cooldowns, failover, multi-key).
5. **KV / response caching** doet (incl. Anthropic prompt caching) om kosten + latency te drukken.
6. (Later) een **auto-router** — nu alleen als optie/fuzz, niet de default.

Bovendien: **stabiliteit, kwaliteit, volledigheid** als rode draad over alles heen.

## Huidige staat (audit-snapshot 2026-08-21)

| Laag | Staat | Bevinding |
| --- | --- | --- |
| Availability-module (`src/availability/`) | Actieve branch | Echte hop/fallback-laag bestaat (`chain/select/resolve/classify`), maar ge-orienteerd op Codex-pools + OAuth-pools. `codex-pool.ts` + `oauth-pool.ts` domineren. |
| Usage-logging (`src/usage/log.ts`) | Bestaat | Append-only `usage.jsonl` (655 regels), mét status/latency/TTFT/cache-tokens. Gat zit in **aggregatie + API + dashboard**. |
| Usage-summary (`src/usage/summary.ts`) | Bestaat | `UsageSummaryTotals` met `cacheRead/ cacheCreation` + surfaces `codex\|claude\|grok`. Niet geknoopt aan een live API/dashboard. |
| Observability (`src/observability/`) | Partial | Prometheus-achtige metrics bridge, maar "process restart = counters op nul". Geen持久 inzicht. |
| Key-pooling (`src/providers/key-failover.ts`) | Bestaat | Per-provider key-pool + cooldown, gekopieerd van `codex/routing.ts`. **In-memory**, geen persistentie over restarts. |
| Cap-cooldown (`src/providers/cap-cooldown.ts`) | Bestaat | Persisteert op live server-config. OK, maar Codex-quota-gedreven. |
| Caching | **Afwezig** | Geen response/KV-cache. Anthropic `cache_control` gaat wel door (pass-through) maar wordt niet benut voor proxy-level cache-hits. |
| Router | **Afwezig** | Geen auto-router. Alleen combo/fallback-ketens (statisch). |

### Concurrentie-patronen om te lenen (zie research-agent rapport)
- **LiteLLM**: weighted round-robin + per-deployment cooldown; append-only usage-log + aggregates; LRU+file response cache; provider-registry adapter interface.
- **Anthropic rate-limits**: 429 met `retry-after` + `anthropic-ratelimit-*` headers; spend-cap 429 heeft **geen** `retry-after` (niet retrien!); `529` is transient overload (wel failover).
- **OpenRouter**: `provider/model` slugs + sticky session routing voor cache-warmth.
- **Cloudflare AI Gateway**: cache-hit% als headline KPI; `x-cache: HIT\|MISS`.

## Het doel: architectuur

```
 Claude Code / Claude Desktop / Codex CLI /任意 OpenAI-compat client
        │  (spreekt 1 protocol: /v1/messages of /v1/responses)
        ▼
 ┌─────────────────────────────────────────────────────────┐
 │  OCX CORE  (provider-agnostisch — KENT geen enkele client)│
 │   ├─ Provider Registry  (adapter interface: translate/   │
 │   │                        call/normalizeUsage/parseRL)   │
 │   ├─ Router           (static combo/fallback + LATER auto)│
 │   ├─ Key Pool         (per-provider, weighted RR + cooldown)│
 │   ├─ Availability     (hop/surface — Codex-pool = opt-in) │
 │   ├─ Usage Sink       (append-only log + aggregates + API)│
 │   └─ KV Cache         (LRU+file, Anthropic prompt-cache)  │
 └─────────────────────────────────────────────────────────┘
        │
        ▼  elke adapter praat met z'n eigen upstream
   Anthropic · OpenAI · Grok · Google · Ollama · … · (Codex account-pool = plugin)
```

**Decoupling-principe:** de core importeert nooit een client-specifieke SDK direct. Alles loopt
via de registry. Codex-account-pools worden een **losse module** achter een feature-flag
(`codexAccountPools: false` default voor nieuwe installs), niet de hoofdstroom.

## Fasering

### Fase A — Stabiliteit & decoupling-groundwork (NU)
- [ ] Typecheck/lint/test-baseline groen op `feat/availability-module`; registreer falende tests.
- [ ] Provider-registry interface expliciet maken (`translate/call/normalizeUsage/parseRateLimit`).
  Bestaande adapters (anthropic, openai-responses, openai-chat, google, azure) achter de interface schuiven.
- [ ] Codex-account-pool + OAuth-pool achter feature-flag; default OFF voor verse configs.
  Claude Code/Desktop worden de default surfaced clients in docs + CLI.
- [ ] `feat/availability-module` afronden/merged naar `dev` zodat we vanaf schone basis bouwen.

**Exit gate:** `bun run prepush` groen; Codex-pools zijn opt-in; geen regressie in Claude-routing.

### Fase B — Usage-insight (hoogste waarde, minst invasief)
- [ ] Usage-record schema vastzetten (provider, model, key, route, latency, tokens in/out,
  cacheCreation/cacheRead, costEur, status, cacheHit, requestId, ts).
- [ ] Append-only `usage.jsonl` + rolling aggregates (per-provider/per-model/per-key, per uur/dag).
- [ ] Management API: `GET /api/v1/usage/summary`, `/aggregate?dim=`, `/records?`, `/realtime`.
- [ ] GUI "Verkeer"-pagina: requests, tokens, cache-hit%, cost, latency p95, per provider.
- [ ] Prometheus scrape blijft bestaan; bridge naar de persistente aggregates.

**Exit gate:** operator ziet in <10s per-provider usage + cache-hit% + cost vanaf GUI/API.

### Fase C — Per-provider key-pooling robuust
- [ ] Key-pool cooldown-state **persisteren** (niet alleen in-memory) — crash-safe.
- [ ] Weighted round-robin + `least-busy` tiebreaker (LiteLLM-model).
- [ ] Provider-specifieke rate-limit parsing: OpenAI `retry-after`/`x-ratelimit-*`,
  Anthropic `anthropic-ratelimit-*` + spend-cap-429-detectie (geen retry), `529` failover.
- [ ] Failover-keten: bij 429/5xx/529 → volgende key, daarna surface originele fout.
- [ ] Live key-pool view in GUI (al deels in `availability/management.ts`) uitbreiden.

**Exit gate:** multi-key provider overleeft 429's zonder handmatige interventie; state overleeft restart.

### Fase D — KV / response caching
- [ ] Cache-laag: `Map` + LRU + TTL, write-through naar file voor warme restart.
  Key = SHA-256(provider, model, endpoint, genormaliseerde body). Redis opt-in voor multi-proc.
  `/v1/responses` blijft buiten de body-cache zolang cache-entries geen volledige
  `previous_response_id` + provider-continuation state kunnen reconstrueren; Messages/Chat zijn veilig.
- [ ] `x-cache: HIT|MISS` + `x-cache-key` response-headers. `x-skip-cache` / `no-store` controls.
- [ ] Streaming: cache eerst na volledige SSE-close (nooit mid-stream).
- [ ] Anthropic prompt caching benutten: `cache_control` pass-through + cache-token-counts in usage.
  Optioneel sticky session routing per `session_id` voor upstream cache-warmth.
- [ ] TTL/eviction defaults (600s TTL, LRU by size + sweep).

**Exit gate:** identieke requests == cache HIT; Anthropic cache-tokens zichtbaar in usage; geen
correctheidsregressie op streaming.

### Fase E — Auto-router (LATER, opt-in/fuzz)
- [ ] Config-gedreven scoring: `score = w1*cost + w2*latency + w3*quality`, weights in config.
- [ ] `quality` uit static tier-table (kost-map); later verfijnd met eigen latency/error-history.
- [ ] Fallback-ketens hergebruiken `allowed_fails`/`cooldown_time` uit Fase C.
- [ ] Default OFF; alleen als `"router": "auto"` expliciet aan. Codex-subagents etc. = fuzz-optie.

**Exit gate:** auto-router kiest meetbaar goedkoper/sneller zonder correctheidsregressie; opt-in.

### Fase F — Kwaliteit & volledigheid (parallel, doorlopend)
- [ ] e2e smoke: start proxy + fixture Claude Messages + Responses turn in CI.
- [ ] Doctor --fix voor top-5 failure modes (shim, catalog inject, port conflict, vault degraded).
- [ ] Privacy-scan groen (geen prompts/keys/account-ids in logs).
- [ ] Doc waarheid: README/ROADMAP op één lijn met `dev`; Claude-first docs.
- [ ] Performance budget: p95 TTFT regression gate na baseline.

## Niet-doelen (explicit)
- Geen dynamic plugin loading van arbitrary paths.
- Geen logs van prompts, API-keys, of account-identifiers.
- Geen fork-afhankelijkheid van upstream release-tempo.
- Auto-router NIET de default maken in Fase E.

## Risico's & mitigatie
| Risico | Mitigatie |
| --- | --- |
| availability-module half-af op huidige branch | Eerst afronden/merge naar `dev` (Fase A) voor we bouwen. |
| Codex-decoupling breekt bestaande Codex-gebruikers | Feature-flag; bestaande configs behouden oude gedrag tot opt-out. |
| KV-cache vervuilt streaming-correctheid | Alleen cache na volledige SSE-close; `no-store` default voor niet-deterministisch. |
| Usage-aggregates drift bij restart | Append-only log = source of truth; aggregates recomputebaar. |
| Spend-cap 429 oneindige retry-loop | Explicit niet-retryen; alleen cooldown + surface. |

## Success criteria (wanneer is dit "klaar")
1. Proxy draait standalone zonder Codex-account-pools (opt-in), Claude Code/Desktop first-class.
2. Operator ziet live per-provider usage + cache-hit% + cost via GUI én API.
3. Multi-key providers failoveren automatisch met persisterende cooldowns.
4. Identieke requests worden gecached; Anthropic prompt-cache benut + zichtbaar.
5. Auto-router bestaat als opt-in, niet de default.
6. `bun run prepush` groen; e2e smoke + privacy-scan groen.
