#!/usr/bin/env bash
# Local proxy/runtime path that does not call GitHub Actions.
#   scripts/local-runtime.sh status
#   scripts/local-runtime.sh up
#   scripts/local-runtime.sh down
#   scripts/local-runtime.sh check
#
# `up` prefers a running loopback proxy, then k3s, then docker compose.
# It prints the missing command or daemon error and exits non-zero when neither
# runtime can start. It does not print tokens, request bodies, or account ids.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HEALTH_URL="${OPENCODEX_HEALTH_URL:-http://127.0.0.1:10100/healthz}"

usage() {
  echo "Usage: scripts/local-runtime.sh status|up|down|check" >&2
  exit 2
}

note() {
  echo "local-runtime: $*"
}

proxy_up() {
  local body
  body="$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null || true)"
  case "$body" in
    *'"service":"opencodex"'*|*"\"service\": \"opencodex\""*) return 0 ;;
    *) return 1 ;;
  esac
}

docker_ready() {
  command -v docker >/dev/null 2>&1 || return 1
  docker info >/dev/null 2>&1 || return 1
  docker compose version >/dev/null 2>&1 || return 1
}

k3s_ready() {
  command -v k3s >/dev/null 2>&1 || return 1
  sudo -n k3s kubectl get nodes >/dev/null 2>&1 || return 1
}

cmd_status() {
  if proxy_up; then
    note "proxy answering at ${HEALTH_URL}"
  else
    note "proxy not answering at ${HEALTH_URL}"
  fi
  if command -v docker >/dev/null 2>&1; then
    if docker info >/dev/null 2>&1; then
      note "docker daemon is reachable"
    else
      note "docker command exists but the daemon is not reachable"
    fi
  else
    note "docker is not installed (command not found)"
  fi
  if command -v k3s >/dev/null 2>&1; then
    if k3s_ready; then
      note "k3s kubectl can list nodes"
    else
      note "k3s is installed but kubectl cannot list nodes"
    fi
  else
    note "k3s is not installed (command not found)"
  fi
}

ensure_token_file() {
  local token_file="${OPENCODEX_API_TOKEN_FILE:-deploy/container/.secrets/api-token}"
  if [ -f "$token_file" ]; then
    return 0
  fi
  note "missing token file ${token_file}"
  note "create it with: mkdir -p deploy/container/.secrets && umask 077 && python3 -c 'import secrets; print(secrets.token_hex(16))' > ${token_file}"
  return 1
}

cmd_up() {
  if proxy_up; then
    note "proxy already answering at ${HEALTH_URL}"
    return 0
  fi
  if k3s_ready; then
    ensure_token_file
    note "applying deploy/k3s/opencodex.yaml"
    sudo -n k3s kubectl apply -f deploy/k3s/opencodex.yaml
    sudo -n k3s kubectl -n opencodex create secret generic opencodex-api-token \
      --from-file=token="${OPENCODEX_API_TOKEN_FILE:-deploy/container/.secrets/api-token}" \
      --dry-run=client -o yaml | sudo -n k3s kubectl apply -f -
    sudo -n k3s kubectl -n opencodex rollout status deployment/opencodex --timeout=180s
    note "port-forward 127.0.0.1:10100 -> service/opencodex (leave this process running)"
    exec sudo -n k3s kubectl -n opencodex port-forward --address 127.0.0.1 service/opencodex 10100:10100
  fi
  if docker_ready; then
    ensure_token_file
    if [ -n "${OPENCODEX_WITH_CLICKHOUSE:-}" ]; then
      note "docker compose up with the observability profile"
      docker compose --profile observability up -d --build
    else
      note "docker compose up"
      docker compose up -d --build
    fi
    return 0
  fi
  note "neither k3s nor a working docker daemon is available, so the container path did not start"
  if ! command -v k3s >/dev/null 2>&1; then
    note "blocker: k3s is not installed (command not found)"
  else
    note "blocker: k3s is installed but 'sudo -n k3s kubectl get nodes' failed"
  fi
  if ! command -v docker >/dev/null 2>&1; then
    note "blocker: docker is not installed (command not found). The compose file is compose.yml"
  else
    note "blocker: docker is installed but 'docker info' failed"
    docker info >/tmp/opencodex-docker-info.txt 2>&1 || true
    tail -n 30 /tmp/opencodex-docker-info.txt >&2 || true
    rm -f /tmp/opencodex-docker-info.txt
  fi
  return 1
}

cmd_down() {
  if docker_ready; then
    docker compose --profile observability down
  else
    note "docker compose is not available; skipped compose down"
  fi
  if k3s_ready; then
    sudo -n k3s kubectl delete -f deploy/k3s/opencodex.yaml --ignore-not-found
  else
    note "k3s is not available; skipped manifest delete"
  fi
}

cmd_check() {
  if ! command -v bun >/dev/null 2>&1; then
    note "blocker: bun is not on PATH"
    return 1
  fi
  bun run typecheck
  if proxy_up; then
    note "proxy identity check passed at ${HEALTH_URL}"
  else
    note "proxy is not up; start it with scripts/local-runtime.sh up or: bun run src/cli/index.ts start --port 10100 --proxy-only"
    return 1
  fi
}

case "${1:-}" in
  status) cmd_status ;;
  up) cmd_up ;;
  down) cmd_down ;;
  check) cmd_check ;;
  *) usage ;;
esac
