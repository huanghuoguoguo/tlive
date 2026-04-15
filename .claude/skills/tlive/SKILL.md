---
name: tlive
description: |
  IM bridge for Claude Code — chat from Telegram, Feishu, or QQ Bot.
  Approve permissions, get streaming responses, manage sessions from your phone.
  Use for: starting IM bridge, configuring IM platforms, checking status,
  diagnosing issues.
  Trigger phrases: "tlive", "IM bridge", "消息桥接", "手机交互", "启动桥接",
  "连接飞书", "连接Telegram", "连接QQ", "诊断", "查看日志", "配置".
  Do NOT use for: building bots, webhook integrations, or general coding tasks.
argument-hint: "setup | start | stop | restart | status | logs [N] | reconfigure | doctor"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
  - Grep
  - Glob
---

# TLive — IM Bridge Skill

You are managing the TLive IM Bridge — bidirectional chat with Claude Code from Telegram, Feishu, or QQ Bot.

The Bridge uses the Claude Agent SDK to interact with Claude Code. It is a pure TypeScript IM bridge with no separate Go Core runtime.

User data: `~/.tlive/`

## Command Parsing

| User says (examples) | Subcommand |
|---|---|
| (no args), `start`, `启动`, `启动桥接` | start |
| `setup`, `configure`, `配置`, `帮我连接 Telegram` | setup |
| `stop`, `停止`, `关闭` | stop |
| `restart`, `重启` | restart |
| `status`, `状态`, `运行状态` | status |
| `logs`, `logs 200`, `查看日志` | logs |
| `reconfigure`, `修改配置`, `换个 bot`, `改 token` | reconfigure |
| `doctor`, `diagnose`, `诊断`, `挂了`, `没反应了` | doctor |
| `push`, `推送`, `推送到手机`, `切换到手机` | push |
| `help`, `帮助`, `怎么用` | help |

**Disambiguation: `status` vs `doctor`** — Use `status` when the user just wants to check if the bridge is running. Use `doctor` when the user reports a problem or suspects something is broken. When in doubt and the user describes a symptom (e.g., "没反应了", "挂了"), prefer `doctor`.

## Config Check (all commands except `setup`)

Before any command except `setup`, check `~/.tlive/config.env`:
- **Missing** → auto-start `setup` wizard
- **Exists** → proceed

## Subcommands

### `/tlive` (no args) or `start` — Start Bridge

```
1. Check config.env → if missing, auto-start setup
2. Start Bridge: tlive start
3. Wait 2s, verify alive: tlive status
4. Report enabled channels
```

### `setup`

Interactive wizard. Collect **one field at a time**, confirm each (mask secrets to last 4 chars).

Before asking for platform credentials, read `references/setup-guides.md` internally. Only mention the specific next step the user needs — don't dump the full guide. Show the relevant guide section only if the user asks for help.

**Step 1 — Choose IM platforms:**
```
AskUserQuestion: "Which IM platforms to enable?
1. Telegram — streaming preview, inline permission buttons
2. Feishu (飞书) — streaming cards, tool progress
3. QQ Bot — for QQ users, interactive buttons
Enter numbers (e.g., 1,3):"
```

**Step 2 — Collect credentials per platform:**

- **Telegram**: Bot Token → confirm (masked) → Chat ID (optional) → Allowed User IDs (optional). **Important:** At least one of Chat ID or Allowed User IDs should be set.
- **Feishu**: App ID → confirm → App Secret → confirm (masked) → Allowed User IDs (optional).
- **QQ Bot**: App ID → confirm → Client Secret → confirm (masked) → Allowed Users (optional).

**Step 3 — General settings:**
- Port (default 8080)
- Auto-generate TL_TOKEN (32-char hex)

**Step 4 — Write config and validate:**
1. Read `references/config.env.example` as the template — use its exact variable names (e.g., `TL_TG_*` for Telegram, `TL_FS_*` for Feishu, `TL_QQ_*` for QQ Bot). Do NOT invent variable names.
2. Show a summary table (secrets masked to last 4 chars)
3. Ask user to confirm before writing
4. `mkdir -p ~/.tlive/{data,logs,runtime}`
5. Write `~/.tlive/config.env` using the template's variable names, then `chmod 600`
6. Validate tokens — read `references/token-validation.md` for exact commands per platform
7. Report results. If validation fails, explain what's wrong.
8. On success: "Setup complete! I'll start the Bridge now." Then auto-start.

### `reconfigure`

1. Read current config from `~/.tlive/config.env`
2. Show current settings in a table (secrets masked to last 4 chars only)
3. Ask what the user wants to change
4. Collect new values one at a time, show where to find each value (show full guide from `references/setup-guides.md` only if asked)
5. Update config file
6. Re-validate any changed tokens
7. Note: "Changes apply to new conversations. No restart needed."

### `stop`

```
tlive stop
```

### `restart`

```
1. Check config.env → if missing, auto-start setup
2. Stop Bridge: tlive stop
3. Start Bridge: tlive start
4. Wait 2s, verify alive: tlive status
5. Report enabled channels
```

### `status`

```
tlive status
```

### `logs`

Extract optional line count N from arguments (default 50).
```
tlive logs [N]
```

### `push`

Push current session to mobile IM for continuing on phone.

```
1. Get current workdir: basename $(git rev-parse --show-toplevel 2>/dev/null || pwd)
2. Get project name from git repo or directory name
3. Generate preview: summarize last 2-3 exchanges in 1-2 sentences (what you're working on)
4. Read TL_WEBHOOK_TOKEN from ~/.tlive/config.env
5. Call API: curl -s -X POST http://localhost:8081/api/push \
   -H "Authorization: Bearer <TL_WEBHOOK_TOKEN>" \
   -H "Content-Type: application/json" \
   -d '{"workdir":"<cwd>","projectName":"<project>","preview":"<summary>"}'
6. Report result:
   - Success: "Session pushed! Check your phone to continue."
   - Connection error: "Bridge not running. Run: tlive start"
```

### `doctor`

Run diagnostics and suggest fixes. For complex issues, read `references/troubleshooting.md`.

```
tlive doctor
```

Then validate IM tokens if configured — read `references/token-validation.md` for commands.

### `help`

Show a clear overview of the TLive system and available commands:

```
TLive — Control Claude Code from your phone

In Claude Code (/tlive):
  /tlive               Start IM Bridge (chat from phone)
  /tlive setup         Configure IM platforms (AI-guided)
  /tlive push          Push session to mobile (continue on phone)
  /tlive reconfigure   Modify specific config fields
  /tlive stop          Stop Bridge
  /tlive status        Show Bridge status
  /tlive logs [N]      Show last N log lines
  /tlive doctor        Diagnose issues + suggest fixes

In terminal (tlive):
  tlive start          Start Bridge daemon
  tlive stop           Stop daemon
  tlive status         Check status

In IM (from phone):
  /new                       Start new conversation
  /sessions                  List sessions in current directory
  /sessions --all            List all sessions
  /session <n>               Switch to session #n
  /cd <path>                 Change working directory
  /pwd                       Show current directory
  /bash <cmd>                Execute shell command
  /settings user|full|isolated  Claude settings scope
  /perm on|off               Permission prompts on/off
  /stop                      Interrupt execution
  /hooks pause|resume        Toggle hook approval
  /status                    Check status
  /upgrade                   Check for updates
  /upgrade skip              Skip current update notification
  /restart                   Restart bridge service
  /help                      Show all commands

Settings hot-reload: Changes apply to new conversations. No restart needed.
```

## Notes

- Always mask secrets in output (show only last 4 characters)
- Always check for config.env before starting — without it the daemon crashes and leaves a stale PID file
- Config at `~/.tlive/config.env`
- Settings hot-reload: config changes apply to new conversations, no restart needed
