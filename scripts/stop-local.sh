#!/usr/bin/env bash
# Stop the UI and Floci started by scripts/start-local.sh.
# Usage: scripts/stop-local.sh [--ui-only]
#   --ui-only  stop only the UI (leave Floci running)
# A running aws-emulator container, if any, is never touched.
# Note: stopping Floci wipes its in-memory resources.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_DIR="$ROOT/.data"
UI_PORT="${UI_PORT:-3297}"
FLOCI_CONTAINER="${FLOCI_CONTAINER:-floci}"
FLOCI_REGISTRY="${FLOCI_REGISTRY_CONTAINER:-floci-aws-ecr-registry}"

STOP_UI=1
STOP_FLOCI=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ui-only) STOP_FLOCI=0 ;;
    -h|--help)
      cat <<'H'
Usage: scripts/stop-local.sh [--ui-only]
  (default)    stop the UI and Floci
  --ui-only    stop only the UI
  Does not stop a running aws-emulator container.
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

if [[ "$STOP_FLOCI" == 1 ]]; then
  if command -v docker >/dev/null; then
    if docker ps -q -f "name=^${FLOCI_CONTAINER}$" 2>/dev/null | grep -q .; then
      docker stop "$FLOCI_CONTAINER" >/dev/null && echo "✓ stopped container $FLOCI_CONTAINER"
    fi
    if docker ps -aq -f "name=^${FLOCI_REGISTRY}$" 2>/dev/null | grep -q .; then
      docker rm -f "$FLOCI_REGISTRY" >/dev/null && echo "✓ removed Floci ECR sidecar $FLOCI_REGISTRY"
    fi
  fi
fi
