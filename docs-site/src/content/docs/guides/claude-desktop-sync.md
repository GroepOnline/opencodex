---
title: Claude Desktop laptop sync
description: Configure and synchronize Claude Desktop routing profiles.
---

The Claude Desktop page can apply a profile and offer **Sync to this laptop**. The sync link launches `ocx-desktop://sync`; use it only on a laptop where the desktop helper is installed. Save & Apply also requests the sync after the server confirms the apply operation.

## Authentication

The library endpoint is `GET /v1/claude-desktop-3p-library`. It uses management authentication, like `GET /api/claude-desktop/3p-library`; a data-plane routing token is not sufficient. Cross-origin requests must also satisfy the configured origin policy.

## Secret handling

The response is the applied 3P library and may contain `inferenceGatewayApiKey`. Treat it as a secret: use HTTPS or a protected local tunnel, do not log the response, and do not share the sync URL or response contents.

## Workflow

1. Save the Claude Desktop profile.
2. Select **Save & Apply** and wait for confirmation.
3. Follow the sync prompt, or select **Sync to this laptop** directly when no mutation is in progress.
