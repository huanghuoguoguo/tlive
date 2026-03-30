#!/bin/bash
# TLive Stop Hook — notify task completion via Go Core
HOOK_JSON=$(cat)

# Only active for tlive-managed sessions
[ -z "$TLIVE_SESSION_ID" ] && exit 0

[ -f "$HOME/.tlive/hooks-paused" ] && exit 0

[ -f "$HOME/.tlive/config.env" ] && source "$HOME/.tlive/config.env" 2>/dev/null
TL_PORT="${TL_PORT:-8080}"
TL_TOKEN="${TL_TOKEN:-}"

# Always inject hook type; inject session ID if available
if command -v jq &>/dev/null; then
  if [ -n "$TLIVE_SESSION_ID" ]; then
    HOOK_JSON=$(echo "$HOOK_JSON" | jq --arg sid "$TLIVE_SESSION_ID" --arg cwd "$PWD" '. + {tlive_session_id: $sid, tlive_hook_type: "stop", tlive_cwd: $cwd}')
  else
    HOOK_JSON=$(echo "$HOOK_JSON" | jq --arg cwd "$PWD" '. + {tlive_hook_type: "stop", tlive_cwd: $cwd}')
  fi
fi

if ! curl -sf "http://localhost:${TL_PORT}/api/status" \
     -H "Authorization: Bearer ${TL_TOKEN}" >/dev/null 2>&1; then
  exit 0
fi

curl -sf -X POST "http://localhost:${TL_PORT}/api/hooks/notify" \
  -H "Authorization: Bearer ${TL_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$HOOK_JSON" \
  --max-time 5 >/dev/null 2>&1

exit 0
