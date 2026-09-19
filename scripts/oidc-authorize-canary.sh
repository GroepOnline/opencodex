#!/bin/sh
# Probe the live Authentik issuer and, optionally, a running OCX authorize
# entry. Never prints secrets. Default issuer is the ChefGroep Auth apply
# from 2026-09-18. /healthz is not this script — use scripts/healthz-smoke.sh.
#
# Optional:
#   OIDC_ISSUER                 default https://auth.chefgroep.online/application/o/ocx/
#   OIDC_CLIENT_ID              default chefgroep-ocx-oidc
#   OPENCODEX_OIDC_CANARY_URL   proxy origin, e.g. http://127.0.0.1:10100
#                               When set, GET /oauth/login must 302 to Authentik.
set -eu

ISSUER="${OIDC_ISSUER:-https://auth.chefgroep.online/application/o/ocx/}"
case "$ISSUER" in
  */) ;;
  *) ISSUER="${ISSUER}/" ;;
esac
CLIENT_ID="${OIDC_CLIENT_ID:-chefgroep-ocx-oidc}"
DISCOVERY="${ISSUER}.well-known/openid-configuration"

if ! command -v python3 >/dev/null 2>&1; then
  echo "oidc-authorize-canary: python3 is required" >&2
  exit 78
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "oidc-authorize-canary: curl is required" >&2
  exit 78
fi

DISCOVERY_BODY="$(curl -fsS --max-time 8 -H 'Accept: application/json' "$DISCOVERY")" || {
  echo "oidc-authorize-canary: discovery unreachable: $DISCOVERY" >&2
  exit 1
}

export OIDC_CANARY_DISCOVERY_BODY="$DISCOVERY_BODY"
export OIDC_CANARY_DISCOVERY_URL="$DISCOVERY"
export OIDC_CANARY_ISSUER="$ISSUER"
export OIDC_CANARY_CLIENT_ID="$CLIENT_ID"
JWKS_URI="$(python3 - <<'PY'
import json, os, sys
try:
    body = json.loads(os.environ["OIDC_CANARY_DISCOVERY_BODY"])
except json.JSONDecodeError as error:
    print(f"oidc-authorize-canary: discovery is not JSON: {error}", file=sys.stderr)
    sys.exit(1)
issuer = os.environ["OIDC_CANARY_ISSUER"]
actual = str(body.get("issuer") or "")
if actual.rstrip("/") != issuer.rstrip("/"):
    print(f"oidc-authorize-canary: discovery issuer {actual!r} != {issuer!r}", file=sys.stderr)
    sys.exit(1)
for key in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
    if not body.get(key):
        print(f"oidc-authorize-canary: discovery missing {key}", file=sys.stderr)
        sys.exit(1)
print(body["jwks_uri"])
PY
)"

curl -fsS --max-time 8 -H 'Accept: application/json' -o /dev/null "$JWKS_URI" || {
  echo "oidc-authorize-canary: JWKS unreachable: $JWKS_URI" >&2
  exit 1
}

if [ -n "${OPENCODEX_OIDC_CANARY_URL:-}" ]; then
  ORIGIN="${OPENCODEX_OIDC_CANARY_URL%/}"
  LOGIN="$ORIGIN/oauth/login"
  HEADERS="$(mktemp)"
  trap 'rm -f "$HEADERS"' EXIT
  STATUS="$(curl -sS --max-time 8 -D "$HEADERS" -o /dev/null -w '%{http_code}' "$LOGIN")" || {
    echo "oidc-authorize-canary: $LOGIN unreachable" >&2
    exit 1
  }
  export OIDC_CANARY_LOGIN_STATUS="$STATUS"
  export OIDC_CANARY_LOGIN_HEADERS="$(cat "$HEADERS")"
  export OIDC_CANARY_LOGIN_URL="$LOGIN"
  python3 - <<'PY'
import os, sys
status = os.environ["OIDC_CANARY_LOGIN_STATUS"]
headers = os.environ["OIDC_CANARY_LOGIN_HEADERS"]
client_id = os.environ["OIDC_CANARY_CLIENT_ID"]
if status != "302":
    print(f"oidc-authorize-canary: {os.environ['OIDC_CANARY_LOGIN_URL']} returned {status}, expected 302", file=sys.stderr)
    sys.exit(1)
location = ""
for line in headers.splitlines():
    if line.lower().startswith("location:"):
        location = line.split(":", 1)[1].strip()
        break
if "application/o/authorize" not in location:
    print("oidc-authorize-canary: authorize redirect is not Authentik", file=sys.stderr)
    sys.exit(1)
if f"client_id={client_id}" not in location:
    print("oidc-authorize-canary: authorize redirect missing client_id", file=sys.stderr)
    sys.exit(1)
if "code_challenge=" not in location or "state=" not in location:
    print("oidc-authorize-canary: authorize redirect missing PKCE/state", file=sys.stderr)
    sys.exit(1)
print(location)
PY
fi

python3 - <<'PY'
import json, os
print(json.dumps({
    "ok": True,
    "issuer": os.environ["OIDC_CANARY_ISSUER"],
    "client_id": os.environ["OIDC_CANARY_CLIENT_ID"],
    "discovery": os.environ["OIDC_CANARY_DISCOVERY_URL"],
    "proxy_login": os.environ.get("OPENCODEX_OIDC_CANARY_URL") or None,
}, indent=2))
PY
