#!/bin/bash
# TLive diagnostic checks for Unix-like environments
set -uo pipefail

TLIVE_HOME="${TLIVE_HOME:-$HOME/.tlive}"
RUNTIME_DIR="${TLIVE_HOME}/runtime"
LOG_DIR="${TLIVE_HOME}/logs"
DATA_DIR="${TLIVE_HOME}/data"
CONFIG_FILE="${TLIVE_HOME}/config.env"

check_cmd() {
  command -v "$1" >/dev/null 2>&1
}

is_running() {
  local pid_file="$1"
  [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null
}

print_json_key_count() {
  local file="$1"
  if [ ! -f "$file" ]; then
    echo "(no data)"
    return
  fi

  if check_cmd node; then
    local count
    count=$(node -e "const fs=require('node:fs'); try { const data=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); console.log(Object.keys(data).length); } catch { process.exit(1); }" "$file" 2>/dev/null) || true
    if [ -n "${count:-}" ]; then
      if [ "$count" -gt 0 ] 2>/dev/null; then
        echo "$count active"
      else
        echo "none"
      fi
      return
    fi
  fi

  echo "(no data)"
}

echo "=== TLive Doctor ==="
echo ""

echo "Dependencies:"
if check_cmd node; then
  echo "  node:    $(node -v)"
else
  echo "  node:    NOT FOUND"
fi

if check_cmd curl; then
  echo "  curl:    OK"
else
  echo "  curl:    NOT FOUND (optional)"
fi

if check_cmd jq; then
  echo "  jq:      OK"
else
  echo "  jq:      NOT FOUND (optional)"
fi

if check_cmd git; then
  echo "  git:     $(git --version | head -1)"
else
  echo "  git:     NOT FOUND"
fi

echo ""

echo "Config:"
if [ -f "$CONFIG_FILE" ]; then
  echo "  config.env: OK"
  set -a
  # shellcheck disable=SC1090
  source "$CONFIG_FILE" 2>/dev/null || true
  set +a
  [ -n "${TL_TOKEN:-}" ] && echo "  TL_TOKEN: set" || echo "  TL_TOKEN: NOT SET"
  [ -n "${TL_TG_BOT_TOKEN:-}" ] && echo "  Telegram: configured" || echo "  Telegram: not configured"
  [ -n "${TL_FS_APP_ID:-}" ] && echo "  Feishu:   configured" || echo "  Feishu:   not configured"
  [ -n "${TL_QQ_APP_ID:-}" ] && echo "  QQ Bot:   configured" || echo "  QQ Bot:   not configured"
else
  echo "  config.env: NOT FOUND (run 'tlive setup')"
fi

echo ""

echo "Processes:"
BRIDGE_PID_FILE="${RUNTIME_DIR}/bridge.pid"
if is_running "$BRIDGE_PID_FILE"; then
  echo "  Bridge:   running (PID $(cat "$BRIDGE_PID_FILE"))"
else
  echo "  Bridge:   not running"
fi

BINDINGS_FILE="${DATA_DIR}/bindings.json"
echo "  Sessions: $(print_json_key_count "$BINDINGS_FILE")"

echo ""
echo "Paths:"
echo "  home:     $TLIVE_HOME"
echo "  runtime:  $RUNTIME_DIR"
echo "  logs:     $LOG_DIR"

echo ""
echo "=== Done ==="
