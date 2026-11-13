#!/usr/bin/env bash
# Stop the UI and AWS Emulator started by scripts/start-local.sh.
# Usage: scripts/stop-local.sh [--ui-only] [--floci]
#   (default is unchanged: stop the UI and AWS Emulator only)
#   --floci also stops the Floci container (and its ECR sidecar, by name)
# Note: stopping a backend wipes its in-memory resources.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_DIR="$ROOT/.data"
UI_PORT="${UI_PORT:-3297}"
CONTAINER="${AWS_EMULATOR_CONTAINER:-aws-emulator}"
FLOCI_CONTAINER="${FLOCI_CONTAINER:-floci}"
FLOCI_REGISTRY="${FLOCI_REGISTRY_CONTAINER:-floci-aws-ecr-registry}"

STOP_UI=1
STOP_EMULATOR=1
STOP_FLOCI=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ui-only) STOP_EMULATOR=0; STOP_FLOCI=0 ;;
    --floci) STOP_FLOCI=1 ;;
    --backend)
      shift
      case "${1:-}" in
        emulator) STOP_FLOCI=0 ;;
        floci) STOP_EMULATOR=0; STOP_FLOCI=1 ;;
        both) STOP_FLOCI=1 ;;
        *) echo "unknown --backend (use emulator, floci, or both)" >&2; exit 2 ;;
      esac
      ;;
    --backend=emulator) STOP_FLOCI=0 ;;
    --backend=floci) STOP_EMULATOR=0; STOP_FLOCI=1 ;;
    --backend=both) STOP_FLOCI=1 ;;
    -h|--help)
      cat <<'H'
Usage: scripts/stop-local.sh [--ui-only] [--floci] [--backend emulator|floci|both]
  (default)               stop the UI and AWS Emulator
  --ui-only               stop only the UI
  --floci / --backend both  also stop Floci
  --backend floci         stop the UI and Floci (leave AWS Emulator running)
H
      exit 0
      ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

stop_pid() { # name pidfile
  local pid; pid="$(cat "$2" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
    echo "✓ stopped $1 (pid $pid)"
  fi
  rm -f "$2"
}

if [[ "$STOP_UI" == 1 ]]; then
  stop_pid UI "$RUN_DIR/ui.pid"
  listeners() {
    if command -v lsof >/dev/null; then lsof -tiTCP:"$UI_PORT" -sTCP:LISTEN 2>/dev/null
    else ss -ltnpH "sport = :$UI_PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2; fi
  }
  for pid in $(listeners | sort -u); do
    if ps -o command= -p "$pid" | grep -q 'next'; then kill "$pid" && echo "✓ stopped UI server (pid $pid)"; fi
  done
fi

if [[ "$STOP_EMULATOR" == 1 ]]; then
  stop_pid "AWS Emulator" "$RUN_DIR/emulator.pid"
  if command -v docker >/dev/null && docker ps -q -f "name=^${CONTAINER}$" 2>/dev/null | grep -q .; then
    docker stop "$CONTAINER" >/dev/null && echo "✓ stopped container $CONTAINER"
  fi
fi

if [[ "$STOP_FLOCI" == 1 ]]; then
  # Only the Floci container and its known ECR sidecar, by exact name.
  if command -v docker >/dev/null; then
    if docker ps -q -f "name=^${FLOCI_CONTAINER}$" 2>/dev/null | grep -q .; then
      docker stop "$FLOCI_CONTAINER" >/dev/null && echo "✓ stopped container $FLOCI_CONTAINER"
    fi
    if docker ps -aq -f "name=^${FLOCI_REGISTRY}$" 2>/dev/null | grep -q .; then
      docker rm -f "$FLOCI_REGISTRY" >/dev/null && echo "✓ removed Floci ECR sidecar $FLOCI_REGISTRY"
    fi
  fi
fi
