#!/bin/sh
# Build the OpenCodex image, run it with a throwaway file-backed token, and
# assert /healthz identity. Requires Docker. Do not run on laptop joep.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "container-smoke: docker is required" >&2
  exit 78
fi

SHA="${OPENCODEX_SMOKE_SHA:-$(git rev-parse HEAD)}"
VERSION="${OPENCODEX_SMOKE_VERSION:-$(python3 -c 'import json; print(json.load(open("package.json"))["version"])')}"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
IMAGE="${OPENCODEX_SMOKE_IMAGE:-opencodex-smoke:${SHA}}"
TOKEN_FILE="$(mktemp)"
cleanup() {
  if [ -n "${CID:-}" ]; then
    docker rm -f "$CID" >/dev/null 2>&1 || true
  fi
  rm -f "$TOKEN_FILE"
}
trap cleanup EXIT INT TERM

umask 077
python3 -c 'import secrets; print(secrets.token_hex(16))' >"$TOKEN_FILE"

docker build \
  --build-arg "VCS_REF=$SHA" \
  --build-arg "VERSION=$VERSION" \
  --build-arg "BUILD_DATE=$BUILD_DATE" \
  -t "$IMAGE" \
  "$ROOT"

CID="$(docker run -d --rm \
  -e OPENCODEX_API_AUTH_TOKEN_FILE=/run/secrets/opencodex_api_token \
  -e OPENCODEX_BIND_HOST=0.0.0.0 \
  -v "$TOKEN_FILE:/run/secrets/opencodex_api_token:ro" \
  -p 127.0.0.1:10100:10100 \
  "$IMAGE")"

i=0
while [ "$i" -lt 30 ]; do
  if curl -fsS http://127.0.0.1:10100/healthz >/tmp/ocx-container-smoke-health.json 2>/dev/null; then
    break
  fi
  i=$((i + 1))
  sleep 2
done

if [ ! -s /tmp/ocx-container-smoke-health.json ]; then
  echo "container-smoke: /healthz did not become ready" >&2
  docker logs "$CID" >&2 || true
  exit 1
fi

python3 - "$SHA" "$VERSION" <<'PY'
import json, sys
sha, version = sys.argv[1], sys.argv[2]
body = json.load(open("/tmp/ocx-container-smoke-health.json"))
assert body.get("status") == "ok", body
assert body.get("service") == "opencodex", body
assert isinstance(body.get("pid"), int) and body["pid"] >= 1, body
assert isinstance(body.get("port"), int), body
assert body.get("version") == version, (body.get("version"), version)
print(json.dumps({
    "ok": True,
    "sha": sha,
    "version": version,
    "health": {k: body.get(k) for k in ("status", "service", "pid", "port", "version", "gitSha")},
}, indent=2))
PY

IMAGE_ID="$(docker inspect --format '{{.Id}}' "$IMAGE")"
echo "imageId=${IMAGE_ID}"
