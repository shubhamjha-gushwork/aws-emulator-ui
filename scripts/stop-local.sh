#!/usr/bin/env bash
# Stop the UI and AWS Emulator started by scripts/start-local.sh.
# Usage: scripts/stop-local.sh [--ui-only]
# Note: stopping the emulator wipes its in-memory resources.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_DIR="$ROOT/.data"
UI_PORT="${UI_PORT:-3297}"
CONTAINER="${AWS_EMULATOR_CONTAINER:-aws-emulator}"

stop_pid() { # name pidfile
  local pid; pid="$(cat "$2" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
    echo "✓ stopped $1 (pid $pid)"
  fi
  rm -f "$2"
}

stop_pid UI "$RUN_DIR/ui.pid"
# also stop a UI server still holding the port, but only if it's ours (a next-server)
listeners() {
  if command -v lsof >/dev/null; then lsof -tiTCP:"$UI_PORT" -sTCP:LISTEN 2>/dev/null
  else ss -ltnpH "sport = :$UI_PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2; fi
}
for pid in $(listeners | sort -u); do
  if ps -o command= -p "$pid" | grep -q 'next'; then kill "$pid" && echo "✓ stopped UI server (pid $pid)"; fi
done

[[ "${1:-}" == "--ui-only" ]] && exit 0

stop_pid "AWS Emulator" "$RUN_DIR/emulator.pid"
if command -v docker >/dev/null && docker ps -q -f "name=^${CONTAINER}$" 2>/dev/null | grep -q .; then
  docker stop "$CONTAINER" >/dev/null && echo "✓ stopped container $CONTAINER"
fi
