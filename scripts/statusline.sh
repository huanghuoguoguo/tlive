#!/bin/bash
# Claude Code Status Line script for TermLive
# Reads JSON session data from stdin, queries Go Core, outputs status line.
# Configure in ~/.claude/settings.json:
#   { "statusLine": { "command": "~/.termlive/bin/statusline.sh" } }

read -r SESSION_JSON

TL_PORT="${TL_PORT:-8080}"
TL_TOKEN="${TL_TOKEN:-}"

# Source config if exists
[ -f "$HOME/.termlive/config.env" ] && source "$HOME/.termlive/config.env" 2>/dev/null

# Query Go Core status
CORE_STATUS=$(curl -sf "http://localhost:${TL_PORT}/api/status" \
  -H "Authorization: Bearer ${TL_TOKEN}" 2>/dev/null)

# Extract from Claude Code session JSON
if command -v jq &>/dev/null && [ -n "$SESSION_JSON" ]; then
  TOKENS_IN=$(echo "$SESSION_JSON" | jq -r '.token_usage.input // 0' 2>/dev/null)
  TOKENS_OUT=$(echo "$SESSION_JSON" | jq -r '.token_usage.output // 0' 2>/dev/null)
  COST=$(echo "$SESSION_JSON" | jq -r '.cost_usd // "0.00"' 2>/dev/null)
else
  TOKENS_IN="?"
  TOKENS_OUT="?"
  COST="?"
fi

# Extract from Go Core
if command -v jq &>/dev/null && [ -n "$CORE_STATUS" ]; then
  SESSIONS=$(echo "$CORE_STATUS" | jq -r '.active_sessions // 0' 2>/dev/null)
  BRIDGE=$(echo "$CORE_STATUS" | jq -r 'if .bridge.connected then "on" else "off" end' 2>/dev/null)
else
  SESSIONS="?"
  BRIDGE="?"
fi

echo "TL: ${SESSIONS}sess | bridge:${BRIDGE} | ${TOKENS_IN}/${TOKENS_OUT}tok | \$${COST}"
