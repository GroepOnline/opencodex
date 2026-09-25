#!/usr/bin/env sh
# Legacy shim; Husky and this compatibility entry point use the same dispatcher.
set -e
exec bun scripts/pre-push.ts
