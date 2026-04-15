---
name: tlive-push
description: Push current session to mobile IM for continuing on phone
---

Push the current Claude Code session to your mobile IM (Telegram/Feishu) so you can continue the conversation on your phone.

## Steps

1. Determine current working directory (use the project root or current cwd)
2. Get project name from git repository name or directory name
3. Call the tlive API endpoint:
   - URL: `POST http://localhost:8081/api/push`
   - Headers: `Authorization: Bearer <TL_WEBHOOK_TOKEN>` (from ~/.tlive/config.env)
   - Body: `{ workdir: "<current-workdir>", projectName: "<project-name>" }`
4. Report the result to user

## Error Handling

If the API call fails with connection error:
- Tell user: "tlive bridge not running. Start with: `tlive start`"

If the API returns an error:
- Show the error message to user

## Success

On success, tell user:
- "Session pushed to mobile. Check your phone to continue."
- Optionally show which channel/chat received the push