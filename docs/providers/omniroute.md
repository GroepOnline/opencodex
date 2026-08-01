# OmniRoute

[OmniRoute](https://github.com/diegosouzapw/OmniRoute) is an open-source, OpenAI-compatible
gateway that aggregates 250+ providers (90+ free) behind a single `/v1` endpoint. Adding it to
opencodex unlocks OmniRoute's free models (Claude, GPT, Gemini, GLM, Kimi, DeepSeek and more)
through one bearer key, with auto-fallback across upstream providers.

OmniRoute speaks the OpenAI Chat Completions wire format, so opencodex reuses the built-in
`openai-chat` adapter. There is no separate adapter to install.

Fleet rule: clients (including joep) reach OmniRoute **only via sofie OCX**. Do not publish
OmniRoute on a LAN/Tailscale address or open a direct joep→OmniRoute tunnel.

## 1. Get an OmniRoute key

1. Sign in at <https://omniroute.online>.
2. Open the dashboard and create an API key.

The hosted cloud API lives at `https://api.omniroute.online/v1`.

## 2. Configure opencodex

OmniRoute is a built-in preset. In the dashboard open **Providers → Add provider → OmniRoute**,
paste your key, and pick a model. The key is sent as `Authorization: Bearer <key>`.

To configure it by hand in `~/.opencodex/config.json`:

```jsonc
{
  "providers": {
    "omniroute": {
      "adapter": "openai-chat",
      "baseUrl": "https://api.omniroute.online/v1",
      "apiKey": "${OCX_OMNIROUTE_KEY}",
      "defaultModel": "claude-sonnet-4-5-thinking"
    }
  }
}
```

The `apiKey` field accepts either a literal key or an `${ENV_VAR}` reference, so export the key
once and reference it as `${OCX_OMNIROUTE_KEY}`:

```bash
export OCX_OMNIROUTE_KEY="your-omniroute-key"
```

`auto` is seeded in the offline catalog but is **not** the default — keep an explicit model until
retry/latency soak is done. Models stay under `omniroute/<id>` (or an explicit combo target);
opencodex does not silently rewrite `mimo-free/*` / `opencode-free/*` ids onto OmniRoute.

## 3. Pick a model

OmniRoute exposes a large, frequently-changing catalog. opencodex ships a small offline seed
mirroring OmniRoute's own `@omniroute/opencode-provider` defaults, plus the `auto` virtual combo
router:

| Model id | Notes |
| --- | --- |
| `auto` | OmniRoute virtual combo router (available, **not** default) |
| `cc/claude-opus-4-8` · `cc/claude-opus-4-7` · `cc/claude-sonnet-4-6` | Claude Code passthrough |
| `cc/claude-haiku-4-5-20251001` | Claude Code passthrough (fast, non-reasoning) |
| `claude-opus-4-5-thinking` · `claude-sonnet-4-5-thinking` | Claude with extended thinking (default seed) |
| `gemini-3.1-pro-high` · `gemini-3-flash` | Gemini |

The live `GET /v1/models` endpoint is the source of truth. To use any other OmniRoute model id
(e.g. a DeepSeek, GLM or Kimi variant), type it into the model field or add it to the provider's
`models` list in config; opencodex forwards unknown ids to OmniRoute verbatim.

## 4. Self-host on loopback (fleet)

OmniRoute ships as a Docker image: `diegosouzapw/omniroute`. Bind **only** to loopback so it is
not reachable from joep or the LAN:

```bash
docker run -d --name omniroute \
  -e REQUIRE_API_KEY=false \
  -p 127.0.0.1:20128:20128 \
  diegosouzapw/omniroute
```

Smoke:

```bash
ss -ltn | grep 20128          # expect 127.0.0.1:20128 only
curl -sS http://127.0.0.1:20128/healthz
curl -sS -H 'Authorization: Bearer sk_omniroute' http://127.0.0.1:20128/v1/models
```

Then configure the OmniRoute provider with loopback + private-network opt-in + placeholder bearer
(when `REQUIRE_API_KEY=false`):

```jsonc
{
  "providers": {
    "omniroute": {
      "adapter": "openai-chat",
      "baseUrl": "http://127.0.0.1:20128/v1",
      "allowPrivateNetwork": true,
      "apiKey": "sk_omniroute",
      "defaultModel": "claude-sonnet-4-5-thinking"
    }
  }
}
```

OmniRoute is registered with `allowBaseUrlOverride`, so the dashboard Add/Edit form exposes a
custom base URL field. Destination policy rejects loopback unless `allowPrivateNetwork: true`.

OmniRoute-internal provider failover counts as **one** OCX upstream attempt under the global
3-attempt budget — OCX does not stack account-pool rotation on this provider.
