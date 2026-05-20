---
name: tlive
description: |
  Feishu/Lark bridge for Claude Code.
  Use for: configuring Feishu credentials, checking bridge status, pushing the
  current Claude Code session to Feishu, reading logs, and diagnosing
  Feishu/Claude Code bridge issues.
  Trigger phrases: "tlive", "Feishu bridge", "飞书桥接", "手机继续",
  "推送到手机", "连接飞书", "诊断", "查看日志", "配置".
  Do NOT use for: opening a new Claude conversation, starting a new chat session,
  building unrelated bots, generic webhook integrations, or non-tlive coding tasks.
argument-hint: "setup | status | logs [N] | reconfigure | doctor | push"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
  - Grep
  - Glob
---

# TLive — Feishu Bridge Skill

You are managing TLive: a local Feishu/Lark bridge that lets the user control
Claude Code from Feishu.

TLive has one supported channel and one runtime:
- Channel: Feishu/Lark
- Runtime/provider: Claude Code through the Claude Agent SDK
- User data: `~/.tlive/`
- Config file: `~/.tlive/config.env`

## Command Parsing

| User says | Subcommand |
|---|---|
| no args, `help`, `帮助`, `怎么用` | help |
| `setup`, `configure`, `配置`, `连接飞书` | setup |
| `status`, `状态`, `运行状态` | status |
| `logs`, `logs 200`, `查看日志` | logs |
| `reconfigure`, `修改配置`, `换 app`, `改密钥` | reconfigure |
| `doctor`, `diagnose`, `诊断`, `挂了`, `没反应了` | doctor |
| `push`, `推送`, `推送到手机`, `切换到手机` | push |

Use `status` when the user only wants to know whether the bridge is running.
Use `doctor` when the user reports a symptom or asks what is broken.

## Config Check

Before every command except `setup`, check whether `~/.tlive/config.env` exists.
If it is missing, run the `setup` flow first.

## Subcommands

### setup

Collect one field at a time. Mask secrets when showing summaries.

Before asking for credentials, read `references/setup-guides.md` internally.
Only show the specific next step the user needs unless they ask for the full guide.

Collect:
- `TL_FS_APP_ID`
- `TL_FS_APP_SECRET`
- `TL_FS_ALLOWED_USERS` (optional)
- `TL_PORT` (default `8080`)
- `TL_TOKEN` (generate a 32-character hex token if missing)
- `TL_PUBLIC_URL` (optional)

Then:
1. Read `references/config.env.example` and use its exact variable names.
2. Show a concise summary with secrets masked.
3. Ask for confirmation before writing.
4. Create `~/.tlive/{data,logs,runtime}`.
5. Write `~/.tlive/config.env` and set mode `600`.
6. Validate Feishu credentials using `references/token-validation.md`.
7. On success, tell the user configuration is ready and run `tlive status`.

### reconfigure

1. Read `~/.tlive/config.env`.
2. Show current values with secrets masked.
3. Ask which Feishu/general fields to change.
4. Update only those fields.
5. Re-validate changed Feishu credentials.
6. Tell the user changes apply to new conversations.

### status

Run:

```bash
tlive status
```

### logs

Extract an optional line count. Default to 50.

```bash
tlive logs [N]
```

### push

Push the current Claude Code session to Feishu so the user can continue from
their phone.

1. Get the current working directory.
2. Build a short project/session preview from the current context.
3. Read `TL_WEBHOOK_TOKEN` from `~/.tlive/config.env`.
4. Call the local push API:

```bash
curl -s -X POST http://localhost:8081/api/push \
  -H "Authorization: Bearer <TL_WEBHOOK_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"workdir":"<cwd>","projectName":"<project>","preview":"<summary>"}'
```

If the request fails because the bridge is not reachable, report that the bridge
is not reachable and show `tlive status` as the next diagnostic command.

### doctor

Run:

```bash
tlive doctor
```

For complex issues, read `references/troubleshooting.md` and then suggest the
smallest concrete fix.

### help

Show the useful commands:

```text
TLive — Control Claude Code from Feishu

In Claude Code:
  /tlive               Show this help
  /tlive setup         Configure Feishu credentials
  /tlive push          Push current session to Feishu
  /tlive reconfigure   Modify config
  /tlive status        Show status
  /tlive logs [N]      Show logs
  /tlive doctor        Diagnose issues

In terminal:
  tlive status
  tlive logs [N]
  tlive doctor

In Feishu:
  /new
  /sessions
  /sessions --all
  /session <n>
  /cd <path>
  /pwd
  /bash <cmd>
  /settings user|full|isolated
  /perm on|off
  /stop
  /hooks pause|resume
  /status
  /upgrade
  /restart
  /help
```

## Notes

- Always mask secrets in output.
- Do not mention unsupported channels or provider/runtime choices.
- If `config.env` is missing, setup comes before other skill commands.
- Config changes are read for new conversations.
