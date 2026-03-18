#!/bin/bash
# TermLive diagnostic checks
set -uo pipefail

TERMLIVE_HOME="${HOME}/.tlive"

echo "=== TermLive Doctor ==="
echo ""

# Check dependencies
echo "Dependencies:"
if command -v node &>/dev/null; then
  echo "  node:    $(node -v)"
else
  echo "  node:    NOT FOUND (required for Bridge)"
fi

if command -v curl &>/dev/null; then
  echo "  curl:    OK"
else
  echo "  curl:    NOT FOUND"
fi

if command -v jq &>/dev/null; then
  echo "  jq:      OK"
else
  echo "  jq:      NOT FOUND (needed for statusline)"
fi

if command -v git &>/dev/null; then
  echo "  git:     $(git --version | head -1)"
else
  echo "  git:     NOT FOUND"
fi

echo ""

# Check Go Core binary
echo "Go Core:"
if [ -x "$TERMLIVE_HOME/bin/tlive" ]; then
  echo "  binary:  OK ($TERMLIVE_HOME/bin/tlive)"
else
  echo "  binary:  NOT FOUND"
fi

echo ""

# Check config
echo "Config:"
if [ -f "$TERMLIVE_HOME/config.env" ]; then
  echo "  config.env: OK"
  # Check key vars without revealing values
  source "$TERMLIVE_HOME/config.env" 2>/dev/null
  [ -n "${TL_TOKEN:-}" ] && echo "  TL_TOKEN: set" || echo "  TL_TOKEN: NOT SET"
  [ -n "${TL_TG_BOT_TOKEN:-}" ] && echo "  Telegram: configured" || echo "  Telegram: not configured"
  [ -n "${TL_DC_BOT_TOKEN:-}" ] && echo "  Discord:  configured" || echo "  Discord:  not configured"
  [ -n "${TL_FS_APP_ID:-}" ] && echo "  Feishu:   configured" || echo "  Feishu:   not configured"
else
  echo "  config.env: NOT FOUND (run 'npx tlive setup')"
fi

echo ""

# Check processes
echo "Processes:"
if [ -f "$TERMLIVE_HOME/runtime/core.pid" ] && kill -0 "$(cat "$TERMLIVE_HOME/runtime/core.pid")" 2>/dev/null; then
  echo "  Go Core:  running (PID $(cat "$TERMLIVE_HOME/runtime/core.pid"))"
else
  echo "  Go Core:  not running"
fi

if [ -f "$TERMLIVE_HOME/runtime/bridge.pid" ] && kill -0 "$(cat "$TERMLIVE_HOME/runtime/bridge.pid")" 2>/dev/null; then
  echo "  Bridge:   running (PID $(cat "$TERMLIVE_HOME/runtime/bridge.pid"))"
else
  echo "  Bridge:   not running"
fi

echo ""

# Check API if running
TL_PORT="${TL_PORT:-8080}"
TL_TOKEN="${TL_TOKEN:-}"
if curl -sf "http://localhost:${TL_PORT}/api/status" -H "Authorization: Bearer ${TL_TOKEN}" >/dev/null 2>&1; then
  echo "API:"
  curl -sf "http://localhost:${TL_PORT}/api/status" -H "Authorization: Bearer ${TL_TOKEN}" 2>/dev/null
  echo ""
else
  echo "API: unreachable (port ${TL_PORT})"
fi

echo ""
echo "=== Done ==="
