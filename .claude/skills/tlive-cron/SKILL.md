---
name: tlive-cron
description: |
  Manage scheduled tasks via tlive's persistent cron scheduler.
  Use when user wants to set up recurring tasks that run even when Claude Code is disconnected.
  Trigger phrases: "定时任务", "cron", "scheduled task", "每天", "每周", "定时执行".
  IMPORTANT: This uses tlive's server-side scheduler (not CC's built-in CronCreate).
argument-hint: "list | add | remove | enable <id> | disable <id> | status"
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
---

# TLive Cron — Server-Side Scheduled Tasks

Manage scheduled tasks that run on the tlive bridge server. Unlike Claude Code's built-in scheduler, tlive cron persists across CC sessions and runs even when CC is disconnected.

## Prerequisites

1. **TL_CRON_ENABLED=true** must be set in ~/.tlive/config.env
2. **tlive bridge must be running** (check with `tlive status`)
3. **TL_WEBHOOK_TOKEN** for API auth

## Commands

| User says | Action |
|-----------|--------|
| (no args), `list`, `列表` | List all cron jobs |
| `add`, `创建`, `设置定时任务` | Create a new job (interactive) |
| `remove <id>`, `删除` | Remove a job |
| `enable <id>` | Enable a job |
| `disable <id>` | Disable a job |
| `status` | Check scheduler status |

## Implementation

### Check Prerequisites

Before any command:
```bash
# Check tlive is running
tlive status || { echo "tlive not running. Run: tlive start"; exit 1; }

# Read config
source ~/.tlive/config.env
echo "PORT=$TL_WEBHOOK_PORT TOKEN=$TL_WEBHOOK_TOKEN CRON=$TL_CRON_ENABLED"
```

If TL_CRON_ENABLED is not "true", tell user to add `TL_CRON_ENABLED=true` to config.env and restart.

### list

```bash
source ~/.tlive/config.env
curl -s -H "Authorization: Bearer $TL_WEBHOOK_TOKEN" \
  http://localhost:$TL_WEBHOOK_PORT/api/cron/jobs | jq .
```

Display jobs in a table: ID, Name, Schedule, Enabled, Next Run, Last Result.

### add (interactive)

Collect from user:
1. **name**: Human-readable job name
2. **schedule**: Cron expression (help user if needed)
3. **prompt**: What to execute when triggered
4. **target**: Ask if they want to specify channelType/chatId or projectName

Cron format: `minute hour day month weekday`
- `0 9 * * *` — daily 9am
- `30 8 * * 1-5` — weekdays 8:30am
- `0 0 1 * *` — 1st of month midnight

Create the job:
```bash
source ~/.tlive/config.env
curl -s -X POST \
  -H "Authorization: Bearer $TL_WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"$name","schedule":"$schedule","prompt":"$prompt","channelType":"$channelType","chatId":"$chatId","enabled":true}' \
  http://localhost:$TL_WEBHOOK_PORT/api/cron/jobs | jq .
```

Report the created job ID and next run time.

### remove <id>

```bash
source ~/.tlive/config.env
curl -s -X DELETE \
  -H "Authorization: Bearer $TL_WEBHOOK_TOKEN" \
  http://localhost:$TL_WEBHOOK_PORT/api/cron/jobs/$ID | jq .
```

### enable/disable <id>

```bash
source ~/.tlive/config.env
curl -s -X POST \
  -H "Authorization: Bearer $TL_WEBHOOK_TOKEN" \
  http://localhost:$TL_WEBHOOK_PORT/api/cron/jobs/$ID/enable | jq .
```

Same for disable.

## Cron Expression Help

When user struggles with schedule format, offer examples:

| Schedule | Meaning |
|----------|---------|
| `0 9 * * *` | Every day at 9:00 |
| `30 8 * * 1-5` | Weekdays at 8:30 |
| `0 12 * * 0` | Sundays at noon |
| `0 0 1 * *` | 1st of month, midnight |
| `0 18 1,15 * *` | 1st and 15th at 6pm |

## Notes

- Jobs are stored in ~/.tlive/runtime/cron-jobs.json
- Jobs survive tlive restarts
- When a job triggers, tlive creates a new Claude session in the target chat/project
- Use `workdir` field to isolate job execution context (e.g., ~/.tlive/cron-tasks/<job-name>/)