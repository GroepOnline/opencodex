#!/bin/sh
# Identity-check GET /healthz the same way the live deploy health gate does.
# Default target is the prod listen path: http://127.0.0.1:10100/healthz
#
# Optional:
#   OPENCODEX_HEALTH_URL            full URL (overrides host/port)
#   OPENCODEX_HEALTH_HOST           default 127.0.0.1
#   OPENCODEX_HEALTH_PORT           default 10100
#   OPENCODEX_SMOKE_EXPECT_SHA      require body.gitSha == this value
#   OPENCODEX_SMOKE_EXPECT_VERSION  require body.version == this value
set -eu

HOST="${OPENCODEX_HEALTH_HOST:-127.0.0.1}"
PORT="${OPENCODEX_HEALTH_PORT:-10100}"
URL="${OPENCODEX_HEALTH_URL:-http://${HOST}:${PORT}/healthz}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "healthz-smoke: python3 is required" >&2
  exit 78
fi

BODY="$(curl -fsS --max-time 4 "$URL")" || {
  echo "healthz-smoke: $URL unreachable" >&2
  exit 1
}

export HEALTHZ_SMOKE_BODY="$BODY"
export HEALTHZ_SMOKE_URL="$URL"
python3 - <<'PY'
import json, os, sys

url = os.environ["HEALTHZ_SMOKE_URL"]
try:
    body = json.loads(os.environ["HEALTHZ_SMOKE_BODY"])
except json.JSONDecodeError as error:
    print(f"healthz-smoke: {url} is not JSON: {error}", file=sys.stderr)
    sys.exit(1)

if body.get("status") != "ok" or body.get("service") != "opencodex":
    print(f"healthz-smoke: health identity mismatch from {url}: {body!r}", file=sys.stderr)
    sys.exit(1)
if not isinstance(body.get("pid"), int) or body["pid"] < 1:
    print(f"healthz-smoke: health process identity missing from {url}", file=sys.stderr)
    sys.exit(1)
if not isinstance(body.get("port"), int):
    print(f"healthz-smoke: health port missing from {url}", file=sys.stderr)
    sys.exit(1)
git_sha = body.get("gitSha")
if not isinstance(git_sha, str) or len(git_sha) == 0:
    print(f"healthz-smoke: health gitSha missing from {url}", file=sys.stderr)
    sys.exit(1)
expect_sha = os.environ.get("OPENCODEX_SMOKE_EXPECT_SHA", "").strip()
if expect_sha and git_sha != expect_sha:
    print(f"healthz-smoke: gitSha {git_sha!r} != {expect_sha!r}", file=sys.stderr)
    sys.exit(1)
version = body.get("version")
expect_version = os.environ.get("OPENCODEX_SMOKE_EXPECT_VERSION", "").strip()
if expect_version:
    if version != expect_version:
        print(f"healthz-smoke: version {version!r} != {expect_version!r}", file=sys.stderr)
        sys.exit(1)
elif not isinstance(version, str) or len(version) == 0:
    print(f"healthz-smoke: health version missing from {url}", file=sys.stderr)
    sys.exit(1)

print(json.dumps({
    "ok": True,
    "url": url,
    "health": {k: body.get(k) for k in ("status", "service", "pid", "port", "version", "gitSha")},
}, indent=2))
PY
