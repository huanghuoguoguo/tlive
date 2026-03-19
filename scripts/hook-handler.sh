#!/bin/bash
# TLive PreToolUse Hook — forwards permission requests to Go Core
# Go Core not running → allow (pass through)
# Go Core running → long-poll until user approves/denies via IM

HOOK_JSON=$(cat)

# Check if hooks are paused
[ -f "$HOME/.tlive/hooks-paused" ] && exit 0

# Inject TLIVE_SESSION_ID into hook JSON
if command -v jq &>/dev/null && [ -n "$TLIVE_SESSION_ID" ]; then
  HOOK_JSON=$(echo "$HOOK_JSON" | jq --arg sid "$TLIVE_SESSION_ID" '. + {tlive_session_id: $sid}')
fi

# Source config
[ -f "$HOME/.tlive/config.env" ] && source "$HOME/.tlive/config.env" 2>/dev/null
TL_PORT="${TL_PORT:-8080}"
TL_TOKEN="${TL_TOKEN:-}"

# Check if Go Core is running
if ! curl -sf "http://localhost:${TL_PORT}/api/status" \
     -H "Authorization: Bearer ${TL_TOKEN}" >/dev/null 2>&1; then
  # Go Core not running → pass through (don't block Claude Code)
  exit 0
fi

# Go Core running → forward permission request (long-poll, up to 300s)
RESPONSE=$(curl -sf -X POST "http://localhost:${TL_PORT}/api/hooks/permission" \
  -H "Authorization: Bearer ${TL_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$HOOK_JSON" \
  --max-time 300 2>/dev/null)

# If curl failed or empty response → allow (don't block)
if [ -z "$RESPONSE" ]; then
  exit 0
fi

# Return the decision to Claude Code
echo "$RESPONSE"
