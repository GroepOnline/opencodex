#!/usr/bin/env sh
# Pre-push hook shim. The actual command list lives in package.json ("prepush").
# Legacy shim; Husky runs `bun run prepush` from .husky/pre-push after `bun install`.
set -e
exec bun run prepush
