#!/bin/sh
# Project-local shadcn MCP launcher. Claude's root .mcp.json starts in repo root.
set -eu

case "$0" in
  /*) script_path=$0 ;;
  *) script_path="$(pwd)/$0" ;;
esac

gui_dir="$(CDPATH= cd -- "$(dirname -- "$script_path")/.." && pwd -P)"
if [ ! -f "$gui_dir/components.json" ]; then
  printf '%s\n' "shadcn MCP: gui/components.json not found" >&2
  exit 1
fi

cd "$gui_dir"
# Exact vetted CLI version, no runtime dependency and no changes to Codex provider routing.
exec npx --yes shadcn@4.21.4 mcp
