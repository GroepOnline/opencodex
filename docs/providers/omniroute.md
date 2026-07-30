# OmniRoute

[OmniRoute](https://github.com/diegosouzapw/OmniRoute) is an open-source, OpenAI-compatible
gateway that aggregates 250+ providers (90+ free) behind a single `/v1` endpoint. Adding it to
opencodex unlocks OmniRoute's free models (Claude, GPT, Gemini, GLM, Kimi, DeepSeek and more)
through one bearer key, with auto-fallback across upstream providers.

OmniRoute speaks the OpenAI Chat Completions wire format, so opencodex reuses the built-in
`openai-chat` adapter. There is no separate adapter to install.

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

## 3. Pick a model

OmniRoute exposes a large, frequently-changing catalog. opencodex ships a small offline seed
mirroring OmniRoute's own `@omniroute/opencode-provider` defaults, plus the `auto` virtual combo
router:

| Model id | Notes |
| --- | --- |
| `auto` | OmniRoute virtual combo router (picks a healthy free upstream automatically) |
| `cc/claude-opus-4-8` · `cc/claude-opus-4-7` · `cc/claude-sonnet-4-6` | Claude Code passthrough |
| `cc/claude-haiku-4-5-20251001` | Claude Code passthrough (fast, non-reasoning) |
| `claude-opus-4-5-thinking` · `claude-sonnet-4-5-thinking` | Claude with extended thinking |
| `gemini-3.1-pro-high` · `gemini-3-flash` | Gemini |

The live `GET /v1/models` endpoint is the source of truth. To use any other OmniRoute model id
(e.g. a DeepSeek, GLM or Kimi variant), type it into the model field or add it to the provider's
`models` list in config; opencodex forwards unknown ids to OmniRoute verbatim.

## 4. Self-host on your fleet (optional)

OmniRoute ships as a Docker image: `diegosouzapw/omniroute` (default port `20128`). Run it on a
fleet server and point opencodex at it instead of the cloud.

```bash
docker run -d --name omniroute -p 20128:20128 diegosouzapw/omniroute
```

Then set the OmniRoute provider's **base URL** to your instance, e.g.
`https://omniroute.internal.example/v1`. OmniRoute is registered with `allowBaseUrlOverride`, so
the dashboard's Add-provider / Edit-provider form exposes a custom base URL field for this. Export
the target as `OCX_OMNIROUTE_BASE_URL` if you template your config from the environment:

```bash
export OCX_OMNIROUTE_BASE_URL="https://omniroute.internal.example/v1"
```

> **Use HTTPS for anything off-host.** opencodex sends the provider's configured key to this base
> URL in an `Authorization: Bearer` header on every request. Over plaintext `http://` that key is
> readable by anyone on the path, so terminate TLS in front of a remote instance (reverse proxy or
> the OmniRoute container's own certificate). Only use `http://` when the endpoint never leaves the
> machine, i.e. a loopback address such as `http://127.0.0.1:20128/v1`. A hostname like
> `http://sofie:20128/v1` crosses the network even on a private LAN.

For a self-hosted instance with `REQUIRE_API_KEY` disabled, OmniRoute accepts the placeholder
key `sk_omniroute`.
