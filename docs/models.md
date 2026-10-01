# Model catalog example

OpenCodex ships a key-free example catalog at
[`deploy/container/model-catalog.example.json`](../deploy/container/model-catalog.example.json).
It demonstrates the configuration shape only; it is not a production inventory.

Provider credentials belong in environment variables or the configured secret
plane. Production provider names, account/resource identifiers, private network
locations and deployment-specific model allowlists must stay outside the public
product repository.

The example uses an OpenAI-compatible chat endpoint:

```json
{
  "defaultProvider": "example-openai",
  "providers": {
    "example-openai": {
      "adapter": "openai-chat",
      "baseUrl": "https://api.example.com/v1",
      "authMode": "key",
      "apiKey": "$EXAMPLE_OPENAI_API_KEY",
      "defaultModel": "example-chat",
      "models": ["example-chat"],
      "selectedModels": ["example-chat"]
    }
  }
}
```

For a real deployment, maintain the fleet/provider inventory in the deployment
repository or secret/configuration system that owns that environment. Validate
the resulting OpenCodex configuration before restart and verify `/v1/models`
through the deployment's authenticated data-plane path.
