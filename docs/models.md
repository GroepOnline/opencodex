# Fleet model catalog

This is the ChefGroep runtime catalog for the OpenCodex proxy. It is not a
built-in provider preset. Keys stay in the host environment file. The key-free
shape lives in [`deploy/container/model-catalog.example.json`](../deploy/container/model-catalog.example.json).

Verified 2026-09-22 against the three Foundry resources in subscription
"Azure subscription 1". Each deployment was `Succeeded` and `chatCompletion=true`.
Chat on `https://<resource>.cognitiveservices.azure.com/openai/v1/chat/completions`
returns 200 with `Authorization: Bearer` for these deployments, which is the
`openai-chat` adapter (`baseUrl` plus `/chat/completions`, no `api-version`
query). The same resources also answer on `openai.azure.com` and
`services.ai.azure.com`; the catalog uses one base URL per resource because
OCX rejects query strings on `baseUrl`.

| Provider id | Resource | Region | Resource group | Env var |
| --- | --- | --- | --- | --- |
| `azure-us` | `openaichef` | eastus | `azureai-us0-east` | `AZURE_OPENAI_KEY_OPENAICHEF` |
| `azure-se` | `openaichef-se` | swedencentral | `azureai-se-central` | `AZURE_OPENAI_KEY_OPENAICHEF_SE` |
| `azure-foundry-us` | `azure-foundry-us` | eastus | `foundry` | `AZURE_OPENAI_KEY_AZURE_FOUNDRY_US` |

Public model ids are `<provider>/<deployment>` because a provider id cannot
contain `/`. Examples: `azure-se/grok-4-6`, `azure-us/DeepSeek-V4-Pro`,
`azure-foundry-us/fw-deepseek-v4-pro`. Deployment names are sent upstream
unchanged.

A bare deployment name routes only when it is unique. `grok-4-6` and
`DeepSeek-V4-1-Flash` exist on both `azure-us` and `azure-se`; the first
configured provider (`azure-us`, also `defaultProvider`) wins for those bare
names. Use the provider prefix when the region matters.

## Not in this catalog

Do not add these upstreams back:

- `jort-7512-resource` (retired Foundry resource, not in the current subscription)
- AWS hosts (`chef-platform-aws-01`, `*.amazonaws.com` Bedrock) — AWS is closed
- `chef-control-az-01` — retired control host
- llama.cpp / weg54 local inference — those servers are stopped
- offline Tailscale addresses

`deploy.yml` still names `chef-control-az-01` as a deploy runner. That workflow
is not a model provider and this catalog does not retarget it.
