#!/bin/bash
# TLive Bridge process management
set -euo pipefail

TLIVE_HOME="${HOME}/.tlive"
RUNTIME_DIR="${TLIVE_HOME}/runtime"
LOG_DIR="${TLIVE_HOME}/logs"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Source config if exists
[ -f "${TLIVE_HOME}/config.env" ] && set -a && source "${TLIVE_HOME}/config.env" && set +a

ensure_dirs() {
  mkdir -p "$RUNTIME_DIR" "$LOG_DIR"
}

is_running() {
  local pidfile="$1"
  [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null
}

start() {
  ensure_dirs

  if is_running "$RUNTIME_DIR/bridge.pid"; then
    echo "Bridge is already running (PID $(cat "$RUNTIME_DIR/bridge.pid"))"
    return
  fi

  local bridge_entry="${SKILL_DIR}/dist/main.mjs"
  if [ ! -f "$bridge_entry" ]; then
    echo "ERROR: Bridge not built."
    echo "Build: cd ${SKILL_DIR} && npm install && npm run build"
    exit 1
  fi

  local runtime="${TL_RUNTIME:-claude}"
  echo "Starting Bridge (runtime: ${runtime})..."
  # Pass the launch directory as default workdir so Claude sessions
  # use the user's project directory, not the bridge install path
  TL_DEFAULT_WORKDIR="${TL_DEFAULT_WORKDIR:-$(pwd)}" TL_RUNTIME="${runtime}" node "$bridge_entry" >> "$LOG_DIR/bridge.log" 2>&1 &
  echo $! > "$RUNTIME_DIR/bridge.pid"
  echo "Bridge started (PID $(cat "$RUNTIME_DIR/bridge.pid"))"
}

stop() {
  if is_running "$RUNTIME_DIR/bridge.pid"; then
    echo "Stopping Bridge (PID $(cat "$RUNTIME_DIR/bridge.pid"))..."
    kill "$(cat "$RUNTIME_DIR/bridge.pid")" 2>/dev/null || true
    rm -f "$RUNTIME_DIR/bridge.pid"
    echo "Bridge stopped."
  else
    echo "Bridge is not running."
  fi
}

status() {
  echo "=== TLive Status ==="
  local runtime="${TL_RUNTIME:-claude}"
  if is_running "$RUNTIME_DIR/bridge.pid"; then
    echo "Bridge:       running (PID $(cat "$RUNTIME_DIR/bridge.pid"), runtime: ${runtime})"
  else
    echo "Bridge:       not running"
  fi

  # Check Go Core (optional, started separately via tlive <cmd>)
  local TL_PORT="${TL_PORT:-8080}"
  local TL_TOKEN="${TL_TOKEN:-}"
  if curl -sf "http://localhost:${TL_PORT}/api/status" \
       -H "Authorization: Bearer ${TL_TOKEN}" >/dev/null 2>&1; then
    echo "Web terminal: running at http://localhost:${TL_PORT}"
  else
    echo "Web terminal: not running (start with: tlive <cmd>)"
  fi
}

logs() {
  local n="${1:-50}"
  echo "=== Bridge (last $n lines) ==="
  tail -n "$n" "$LOG_DIR/bridge.log" 2>/dev/null || echo "(no log file)"
}

case "${1:-}" in
  start)  start ;;
  stop)   stop ;;
  status) status ;;
  logs)   logs "${2:-50}" ;;
  *)      echo "Usage: $0 {start|stop|status|logs [N]}" ;;
esac
