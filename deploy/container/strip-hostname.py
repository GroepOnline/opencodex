#!/usr/bin/env python3
"""Strip the bun-runtime hostname pin from a carried opencodex config.

The state-carry-forward copies the host bun runtime's config.json into the
container state dir. It pins ``hostname`` to the host Tailscale IPv4 (the
bun runtime binds that address). Inside the bridge network that address does
not exist, so the container's port-probe fails with PortUnavailableError and
exits 1. Stripping the key lets the container bind 0.0.0.0 via
OPENCODEX_BIND_HOST while keeping every other carried setting.
"""
import json
import os
import sys


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: strip-hostname.py /path/to/config.json", file=sys.stderr)
        return 2
    path = sys.argv[1]
    try:
        with open(path, encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, json.JSONDecodeError):
        # Leave corrupt/partial config for the app to handle; never fail the
        # deploy over a config we only touch opportunistically.
        print("carried config unreadable; leaving as-is", file=sys.stderr)
        return 0
    if not isinstance(cfg, dict) or "hostname" not in cfg:
        print("carried config has no hostname to strip")
        return 0
    del cfg["hostname"]
    tmp = f"{path}.cg-strip"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    print("stripped hostname from carried config")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())