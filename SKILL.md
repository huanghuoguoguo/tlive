---
name: tlive
description: |
  IM bridge for AI coding tools — chat with Claude Code / Codex from
  Telegram, Discord, or Feishu. Approve permissions, get streaming responses,
  manage sessions from your phone.
  Use for: starting IM bridge, configuring IM platforms, checking status,
  diagnosing issues.
  Trigger phrases: "tlive", "IM bridge", "消息桥接", "手机交互", "启动桥接",
  "连接飞书", "连接Telegram", "诊断", "查看日志".
  Do NOT use for: building bots, webhook integrations, or general coding tasks.
argument-hint: "setup | stop | status | doctor"
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

You are managing the TLive IM Bridge — bidirectional chat with AI coding tools from Telegram, Discord, or Feishu.

The Bridge uses the Claude Agent SDK (or Codex SDK) to interact with the AI coding tool. It is completely independent from the optional Go Core web terminal server.

User data: `~/.tlive/`
Skill directory (SKILL_DIR): the repo root where this SKILL.md lives.

## Command Parsing

| User says | Subcommand |
|-----------|------------|
| (no args), `start`, `启动` | → start bridge |
| `setup`, `configure`, `配置`, `帮我连接 Telegram` | → setup |
| `stop`, `停止`, `关闭` | → stop |
| `status`, `状态` | → status |
| `doctor`, `diagnose`, `诊断`, `挂了` | → doctor |

## Runtime Detection

- `AskUserQuestion` available → Claude Code → interactive wizard
- Not available → Codex / other → show config example, non-interactive

## Config Check (all commands except `setup`)

Before any command except `setup`, check `~/.tlive/config.env`:
- Missing → auto-start `setup` (Claude Code) or show `SKILL_DIR/config.env.example` (other)
- Exists → proceed

## Subcommands

### `/tlive` (no args) — Start Bridge

```
1. Check config.env → if missing, auto-start setup
2. Check Bridge PID file → if running, show status instead
3. Start Bridge daemon:
   node SKILL_DIR/bridge/dist/main.mjs &
4. Write PID to ~/.tlive/runtime/bridge.pid
5. Check Go Core availability:
   curl -sf http://localhost:${TL_PORT}/api/status
6. Report:
   "Bridge started."
   "  Telegram: ✓ connected"
   "  Discord:  ✓ connected"
   If Go Core detected:
   "  Web terminal: http://localhost:8080?token=..."
```

### `setup`

Interactive wizard. Collect **one field at a time**, confirm each (mask secrets to last 4 chars).

**Step 1 — Choose IM platforms:**
```
AskUserQuestion: "Which IM platforms to enable?
1. Telegram — streaming preview, inline permission buttons
2. Discord — team use, channel-level access control
3. Feishu (飞书) — streaming cards, tool progress
Enter numbers (e.g., 1,3):"
```

**Step 2 — Collect credentials per platform:**

Telegram: Bot Token → Chat ID (optional) → Allowed User IDs (optional)
Discord: Bot Token → Allowed User IDs → Allowed Channel IDs (optional)
Feishu: App ID → App Secret → Allowed User IDs (optional)

**Step 3 — General settings:**
- Port (default 8080)
- Public URL (optional, for web links in IM)
- Auto-generate TL_TOKEN (32-char hex)

**Step 4 — Write config:**
```bash
mkdir -p ~/.tlive/{data,logs,runtime}
# Write ~/.tlive/config.env with all settings
chmod 600 ~/.tlive/config.env
```

Tell user: "Setup complete! I'll start the Bridge now." Then auto-start bridge.

### `stop`

```bash
PID_FILE=~/.tlive/runtime/bridge.pid
if [ -f "$PID_FILE" ]; then
  kill "$(cat "$PID_FILE")" 2>/dev/null
  rm -f "$PID_FILE"
  echo "Bridge stopped."
else
  echo "Bridge is not running."
fi
```

### `status`

```bash
# Check Bridge
if [ -f ~/.tlive/runtime/bridge.pid ] && kill -0 "$(cat ~/.tlive/runtime/bridge.pid)" 2>/dev/null; then
  echo "Bridge: running (PID $(cat ~/.tlive/runtime/bridge.pid))"
else
  echo "Bridge: not running"
fi

# Check Go Core (optional)
source ~/.tlive/config.env 2>/dev/null
if curl -sf "http://localhost:${TL_PORT:-8080}/api/status" -H "Authorization: Bearer ${TL_TOKEN}" >/dev/null 2>&1; then
  echo "Web terminal: available at http://localhost:${TL_PORT:-8080}"
else
  echo "Web terminal: not running (start with: tlive <cmd>)"
fi
```

### `doctor`

Check:
1. Node.js version (>= 22)
2. Config file exists and readable
3. Bridge built (`SKILL_DIR/bridge/dist/main.mjs` exists)
4. Bridge process running
5. Go Core reachable (optional)
6. IM platform token validity (if configured)

```bash
echo "=== TLive Doctor ==="
node -v || echo "Node.js: NOT FOUND"
[ -f ~/.tlive/config.env ] && echo "Config: OK" || echo "Config: NOT FOUND"
[ -f SKILL_DIR/bridge/dist/main.mjs ] && echo "Bridge build: OK" || echo "Bridge build: NOT FOUND — run: cd SKILL_DIR/bridge && npm run build"
```

## Notes

- Always mask secrets (last 4 chars only)
- Bridge and Go Core web terminal are independent — Bridge works without Go Core
- Go Core is started separately via `tlive <cmd>` in a terminal, not by this skill
- Config at `~/.tlive/config.env` — shared by both Bridge and Go Core
