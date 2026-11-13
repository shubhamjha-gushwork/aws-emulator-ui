#!/usr/bin/env bash
# Start Floci and the UI locally. Both only listen on 127.0.0.1.
# Usage: scripts/start-local.sh [--seed]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FLOCI_PORT="${FLOCI_PORT:-4566}"
UI_PORT="${UI_PORT:-3297}"
FLOCI_CONTAINER="${FLOCI_CONTAINER:-floci}"
FLOCI_IMAGE="${FLOCI_IMAGE:-floci/floci:latest}"
FLOCI_NETWORK="${FLOCI_NETWORK:-floci-net}"
if [[ "$(uname)" == "Darwin" ]]; then LOG_DIR="${LOG_DIR:-$HOME/Library/Logs/aws-emulator-ui}"; else LOG_DIR="${LOG_DIR:-$ROOT/.data/logs}"; fi
RUN_DIR="$ROOT/.data"
SEED=0

usage() {
  cat <<'H'
Usage: scripts/start-local.sh [--seed]
  Starts Floci (http://127.0.0.1:4566) and the UI (http://127.0.0.1:3297).
  --seed    seed demo data into Floci after start
  A running aws-emulator container, if any, is left alone.
H
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --seed) SEED=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
mkdir -p "$LOG_DIR" "$RUN_DIR"

floci_health() { curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$FLOCI_PORT/_floci/health" 2>/dev/null | grep -q '^200$'; }

start_floci() {
  command -v docker >/dev/null || { echo "✗ Docker is required to run Floci" >&2; exit 1; }
  docker info >/dev/null 2>&1 || { echo "✗ Docker is installed but not running (start Docker Desktop)" >&2; exit 1; }
  docker network inspect "$FLOCI_NETWORK" >/dev/null 2>&1 || docker network create "$FLOCI_NETWORK" >/dev/null
  if ! docker image inspect "$FLOCI_IMAGE" >/dev/null 2>&1; then
    echo "→ pulling $FLOCI_IMAGE …"
    docker pull "$FLOCI_IMAGE"
  fi
  local running net
  running="$(docker inspect -f '{{.State.Running}}' "$FLOCI_CONTAINER" 2>/dev/null || true)"
  net="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$FLOCI_CONTAINER" 2>/dev/null || true)"
  if [[ "$running" == "true" ]] && grep -qw "$FLOCI_NETWORK" <<<"$net"; then
    return 0
  fi
  if [[ -n "$running" ]]; then
    echo "→ recreating container $FLOCI_CONTAINER on $FLOCI_NETWORK …"
    docker rm -f "$FLOCI_CONTAINER" >/dev/null 2>&1 || true
  else
    echo "→ starting container $FLOCI_CONTAINER …"
  fi
  docker run -d --name "$FLOCI_CONTAINER" --memory=2g \
    --network "$FLOCI_NETWORK" \
    -p "127.0.0.1:$FLOCI_PORT:4566" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -e FLOCI_HOSTNAME=floci \
    -e FLOCI_SERVICES_DOCKER_NETWORK="$FLOCI_NETWORK" \
    -e FLOCI_SERVICES_ECR_DOCKER_NETWORK="$FLOCI_NETWORK" \
    -e FLOCI_SERVICES_ECS_PUBLISH_AWSVPC_PORTS_TO_HOST=true \
    -e FLOCI_SERVICES_ECS_DYNAMIC_AWSVPC_HOST_PORTS=true \
    -e FLOCI_SERVICES_ECS_HOST_PORT_BIND_ADDRESS=127.0.0.1 \
    "$FLOCI_IMAGE" >/dev/null
}

if floci_health; then
  echo "✓ Floci already answering on http://127.0.0.1:$FLOCI_PORT"
else
  start_floci
  for _ in $(seq 1 60); do floci_health && break; sleep 1; done
  floci_health || { echo "✗ Floci did not become healthy; see 'docker logs $FLOCI_CONTAINER'" >&2; exit 1; }
  echo "✓ Floci healthy on http://127.0.0.1:$FLOCI_PORT"
fi

if curl -s -o /dev/null "http://127.0.0.1:$UI_PORT/api/status"; then
  echo "✓ UI already running on http://127.0.0.1:$UI_PORT"
else
  [[ -d node_modules ]] || npm install
  [[ -f .next/BUILD_ID ]] || npm run build
  echo "→ starting UI …"
  nohup npx next start -H 127.0.0.1 -p "$UI_PORT" >>"$LOG_DIR/ui.log" 2>&1 &
  echo $! >"$RUN_DIR/ui.pid"
  for _ in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:$UI_PORT/api/status" && break; sleep 1; done
  curl -s -o /dev/null "http://127.0.0.1:$UI_PORT/api/status" || { echo "✗ UI failed to start; see $LOG_DIR/ui.log" >&2; exit 1; }
  echo "✓ UI running on http://127.0.0.1:$UI_PORT (logs: $LOG_DIR/ui.log)"
fi

if [[ "$SEED" == 1 ]]; then npm run seed; fi
