#!/usr/bin/env bash
# Start AWS Emulator and/or Floci, and the UI, locally.
#   Linux:          uses the installed `aws-emulator` binary (or Docker if it's missing).
#   macOS/Windows:  runs the emulator in Docker, as in the official guide.
# Both only listen on 127.0.0.1.
# Usage: scripts/start-local.sh [--seed] [--rebuild] [--floci] [--backend emulator|floci|both]
#   (default --backend emulator: same as before — AWS Emulator + UI)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${AWS_EMULATOR_PORT:-9297}"
FLOCI_PORT="${FLOCI_PORT:-4566}"
UI_PORT="${UI_PORT:-3297}"
CONTAINER="${AWS_EMULATOR_CONTAINER:-aws-emulator}"
IMAGE="${AWS_EMULATOR_IMAGE:-aws-emulator}"
FLOCI_CONTAINER="${FLOCI_CONTAINER:-floci}"
FLOCI_IMAGE="${FLOCI_IMAGE:-floci/floci:latest}"
FLOCI_NETWORK="${FLOCI_NETWORK:-floci-net}"
if [[ "$(uname)" == "Darwin" ]]; then LOG_DIR="${LOG_DIR:-$HOME/Library/Logs/aws-emulator-ui}"; else LOG_DIR="${LOG_DIR:-$ROOT/.data/logs}"; fi
RUN_DIR="$ROOT/.data"
SEED=0; REBUILD=0
START_EMULATOR=1
START_FLOCI=0
usage() {
  cat <<'H'
Usage: scripts/start-local.sh [--seed] [--rebuild] [--floci] [--backend emulator|floci|both]
  --backend emulator  start AWS Emulator + UI (default, unchanged)
  --backend floci     start Floci + UI (leaves a running AWS Emulator alone)
  --backend both      start both backends + UI
  --floci             same as --backend both
  --seed              seed demo data into the active UI backend after start
  --rebuild           rebuild the AWS Emulator image before starting it
H
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --seed) SEED=1 ;;
    --rebuild) REBUILD=1 ;;
    --floci) START_EMULATOR=1; START_FLOCI=1 ;;
    --backend)
      shift
      case "${1:-}" in
        emulator) START_EMULATOR=1; START_FLOCI=0 ;;
        floci) START_EMULATOR=0; START_FLOCI=1 ;;
        both) START_EMULATOR=1; START_FLOCI=1 ;;
        *) echo "unknown --backend (use emulator, floci, or both)" >&2; exit 2 ;;
      esac
      ;;
    --backend=emulator) START_EMULATOR=1; START_FLOCI=0 ;;
    --backend=floci) START_EMULATOR=0; START_FLOCI=1 ;;
    --backend=both) START_EMULATOR=1; START_FLOCI=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
mkdir -p "$LOG_DIR" "$RUN_DIR" "$HOME/.aws/emulator"

emulator_health() { curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:$PORT/__admin/health" 2>/dev/null | grep -q '^200$'; }
floci_health() { curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$FLOCI_PORT/_floci/health" 2>/dev/null | grep -q '^200$'; }

# ---- AWS Emulator ---------------------------------------------------------
if [[ "$START_EMULATOR" == 1 ]]; then
  if emulator_health; then
    echo "✓ AWS Emulator already answering on https://127.0.0.1:$PORT"
  elif [[ "$(uname)" == "Linux" ]] && command -v aws-emulator >/dev/null && [[ -z "${USE_DOCKER:-}" ]]; then
    echo "→ starting aws-emulator (native) …"
    nohup aws-emulator -p "$PORT" -t off >"$LOG_DIR/emulator.log" 2>&1 &
    echo $! >"$RUN_DIR/emulator.pid"
  else
    command -v docker >/dev/null || { echo "✗ Docker is required to run AWS Emulator on this OS" >&2; exit 1; }
    docker info >/dev/null 2>&1 || { echo "✗ Docker is installed but not running (start Docker Desktop)" >&2; exit 1; }
    if [[ "$REBUILD" == 1 ]] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
      case "$(uname -m)" in arm64|aarch64) ARCH=aarch64 ;; *) ARCH=x86_64 ;; esac
      echo "→ building image $IMAGE ($ARCH) …"
      docker build --pull --build-arg EMULATOR_ARCH="$ARCH" -t "$IMAGE" "$ROOT/docker"
    fi
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    echo "→ starting container $CONTAINER …"
    # -e HOME + the bind mount make the emulator write its per-run keys/CA to
    # ~/.aws/emulator/$PORT on this machine, which is where the UI's Auto mode looks.
    docker run -d --rm --name "$CONTAINER" --memory=2g --memory-swap=2g \
      -p "127.0.0.1:$PORT:$PORT" \
      -e HOME="$HOME" -v "$HOME/.aws/emulator:$HOME/.aws/emulator" \
      "$IMAGE" -p "$PORT" --telemetry off >/dev/null
  fi
  for _ in $(seq 1 60); do emulator_health && break; sleep 1; done
  emulator_health || { echo "✗ emulator did not become healthy; see 'docker logs $CONTAINER' or $LOG_DIR/emulator.log" >&2; exit 1; }
  for _ in $(seq 1 20); do [[ -s "$HOME/.aws/emulator/$PORT/emulator_credentials" ]] && break; sleep 0.5; done
  echo "✓ AWS Emulator healthy on https://127.0.0.1:$PORT"
fi

# ---- Floci ----------------------------------------------------------------
start_floci() {
  command -v docker >/dev/null || { echo "✗ Docker is required to run Floci" >&2; exit 1; }
  docker info >/dev/null 2>&1 || { echo "✗ Docker is installed but not running (start Docker Desktop)" >&2; exit 1; }
  docker network inspect "$FLOCI_NETWORK" >/dev/null 2>&1 || docker network create "$FLOCI_NETWORK" >/dev/null
  if ! docker image inspect "$FLOCI_IMAGE" >/dev/null 2>&1; then
    echo "→ pulling $FLOCI_IMAGE …"
    docker pull "$FLOCI_IMAGE"
  fi
  # Recreate only our Floci container if it's missing, stopped, or not on floci-net.
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

if [[ "$START_FLOCI" == 1 ]]; then
  if floci_health; then
    echo "✓ Floci already answering on http://127.0.0.1:$FLOCI_PORT"
  else
    start_floci
    for _ in $(seq 1 60); do floci_health && break; sleep 1; done
    floci_health || { echo "✗ Floci did not become healthy; see 'docker logs $FLOCI_CONTAINER'" >&2; exit 1; }
    echo "✓ Floci healthy on http://127.0.0.1:$FLOCI_PORT"
  fi
fi

# ---- UI -------------------------------------------------------------------
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
