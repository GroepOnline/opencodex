# OnlineChefGroep fleet pin — OpenCodex (`ocx`)

| Field | Value |
|-------|-------|
| Upstream | https://github.com/lidge-jun/opencodex |
| Org fork | https://github.com/OnlineChefGroep/opencodex |
| npm package | `@bitkyc08/opencodex` |
| **Pinned host version (joep)** | **2.7.33** |
| Pin tag | `v2.7.33` |
| Pin commit | `6d6bef8b98d762ff9679916546cb44e8e3effebc` |
| Verified | 2026-07-22 on `joep` (Ubuntu) |

## Host install (joep)

```text
CLI:     ~/.local/bin/ocx  →  @bitkyc08/opencodex@2.7.33
Config:  ~/.opencodex/config.json
Proxy:   http://127.0.0.1:10100
Usage:   ~/.opencodex/usage.jsonl
```

Do **not** auto-upgrade past the pin without an explicit fleet decision. Latest npm may be newer; this host stays on 2.7.33 until bumped here and in chefgroep-vault `PROVIDERS.md`.

## Pin / reinstall

```bash
npm install -g @bitkyc08/opencodex@2.7.33
ocx --version   # expect: opencodex 2.7.33
```

Checkout this tag in the fork:

```bash
git fetch --tags
git checkout v2.7.33
```

## Role in the ChefGroep stack

- **ocx** = runtime provider proxy + model routing for Codex (and friends).
- **chefgroep-vault** = source of truth for OAuth/file account capture & switch (`~/.codex/auth.json` ↔ profiles).
- After `chefvault accounts switch` of a **codex** account, vault forces ocx onto the main Codex login (`activeCodexAccountId = __main__`) so the proxy reads the newly installed live auth.
- **coding-provider-manager (`cpm`)** = API-key vault + tool adapters; OAuth account switching delegates to chefvault (driver `chefvault`).
