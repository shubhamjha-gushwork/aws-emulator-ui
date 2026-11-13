#!/usr/bin/env bash
# Start AWS Emulator and the UI locally.
#   Linux:          uses the installed `aws-emulator` binary (or Docker if it's missing).
#   macOS/Windows:  runs the emulator in Docker, as in the official guide.
# Both only listen on 127.0.0.1. Usage: scripts/start-local.sh [--seed] [--rebuild]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${AWS_EMULATOR_PORT:-9297}"
UI_PORT="${UI_PORT:-3297}"
CONTAINER="${AWS_EMULATOR_CONTAINER:-aws-emulator}"
IMAGE="${AWS_EMULATOR_IMAGE:-aws-emulator}"
if [[ "$(uname)" == "Darwin" ]]; then LOG_DIR="${LOG_DIR:-$HOME/Library/Logs/aws-emulator-ui}"; else LOG_DIR="${LOG_DIR:-$ROOT/.data/logs}"; fi
RUN_DIR="$ROOT/.data"
SEED=0; REBUILD=0
for a in "$@"; do
  case "$a" in
    --seed) SEED=1 ;;
    --rebuild) REBUILD=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done
mkdir -p "$LOG_DIR" "$RUN_DIR" "$HOME/.aws/emulator"

health() { curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:$PORT/__admin/health" 2>/dev/null | grep -q '^200$'; }

# ---- emulator -------------------------------------------------------------
if health; then
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
for _ in $(seq 1 60); do health && break; sleep 1; done
health || { echo "✗ emulator did not become healthy; see 'docker logs $CONTAINER' or $LOG_DIR/emulator.log" >&2; exit 1; }
for _ in $(seq 1 20); do [[ -s "$HOME/.aws/emulator/$PORT/emulator_credentials" ]] && break; sleep 0.5; done
echo "✓ AWS Emulator healthy on https://127.0.0.1:$PORT"

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
