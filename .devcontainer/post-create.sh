#!/usr/bin/env bash
# Idempotent source bootstrap for the coding devcontainer.
# The prod-like proxy path is repo-root compose.yml + scripts/healthz-smoke.sh.
set -euo pipefail

cd "$(dirname "$0")/.."

bun install --frozen-lockfile
bun install --frozen-lockfile --cwd gui

if [ ! -f .env ]; then
  cp .env.example .env
fi
