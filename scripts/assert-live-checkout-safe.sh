#!/usr/bin/env bash
# Refuse a live working tree that would lose unpublished commits or a dirty snowflake.
# Usage: assert-live-checkout-safe.sh <checkout-dir> [target-sha]
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: assert-live-checkout-safe.sh <checkout-dir> [target-sha]" >&2
  exit 2
fi

checkout=$1
target=${2-}

if [[ ! -d $checkout ]]; then
  echo "assert-live-checkout-safe: not a directory: $checkout" >&2
  exit 2
fi

cd "$checkout"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "assert-live-checkout-safe: not a git checkout: $checkout" >&2
  exit 2
fi

# Porcelain only as a boolean. Do not print the listing (paths can be sensitive).
if [[ -n $(git status --porcelain) ]]; then
  echo "assert-live-checkout-safe: refusing dirty working tree" >&2
  exit 1
fi

if [[ -n $target ]]; then
  if ! git merge-base --is-ancestor HEAD "$target"; then
    echo "assert-live-checkout-safe: HEAD is not an ancestor of $target (would drop live-only commits)" >&2
    exit 1
  fi
fi
