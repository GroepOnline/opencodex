#!/bin/sh
set -eu

if [ -n "${OPENCODEX_API_AUTH_TOKEN_FILE:-}" ]; then
  if [ ! -r "$OPENCODEX_API_AUTH_TOKEN_FILE" ]; then
    echo "OpenCodex API auth token file is not readable" >&2
    exit 78
  fi
  OPENCODEX_API_AUTH_TOKEN="$(cat "$OPENCODEX_API_AUTH_TOKEN_FILE")"
  export OPENCODEX_API_AUTH_TOKEN
fi

exec "$@"
