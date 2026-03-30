#!/bin/bash
# TLive PermissionRequest Hook — forwards Claude Code permission dialogs to IM
# Core not running → exit 0 → dialog shows locally (normal behavior)
# Core running → forward to IM, long-poll until user approves/denies

HOOK_JSON=$(cat)

# Only active for tlive-managed sessions (tlive claude injects this env var)
[ -z "$TLIVE_SESSION_ID" ] && exit 0

# Hooks paused → fall through to local dialog
[ -f "$HOME/.tlive/hooks-paused" ] && exit 0

# Inject TLIVE_SESSION_ID
if command -v jq &>/dev/null && [ -n "$TLIVE_SESSION_ID" ]; then
  HOOK_JSON=$(echo "$HOOK_JSON" | jq --arg sid "$TLIVE_SESSION_ID" --arg cwd "$PWD" '. + {tlive_session_id: $sid, tlive_cwd: $cwd}')
fi

# Source config
[ -f "$HOME/.tlive/config.env" ] && source "$HOME/.tlive/config.env" 2>/dev/null
TL_PORT="${TL_PORT:-8080}"
TL_TOKEN="${TL_TOKEN:-}"

# Core not running → fall through to local dialog
if ! curl -sf "http://localhost:${TL_PORT}/api/status" \
     -H "Authorization: Bearer ${TL_TOKEN}" >/dev/null 2>&1; then
  exit 0
fi

# Forward to Core (long-poll, up to 300s)
RESPONSE=$(curl -sf -X POST "http://localhost:${TL_PORT}/api/hooks/permission" \
  -H "Authorization: Bearer ${TL_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$HOOK_JSON" \
  --max-time 300 2>/dev/null)

# No response → fall through to local dialog
if [ -z "$RESPONSE" ]; then
  exit 0
fi

# Build PermissionRequest decision response
if command -v jq &>/dev/null; then
  DECISION=$(echo "$RESPONSE" | jq -r '.decision // "allow"')

  case "$DECISION" in
    allow)
      jq -n '{
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" }
        }
      }'
      ;;
    allow_always)
      # Echo back permission_suggestions as updatedPermissions
      # This is equivalent to the user clicking "Always Allow" in the dialog
      SUGGESTIONS=$(echo "$RESPONSE" | jq '.suggestions // []')
      jq -n --argjson perms "$SUGGESTIONS" '{
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "allow",
            updatedPermissions: $perms
          }
        }
      }'
      ;;
    deny)
      jq -n '{
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "deny" }
        }
      }'
      ;;
  esac
else
  echo "$RESPONSE"
fi
