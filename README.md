# TLive

[中文文档](README_CN.md)

Terminal live monitoring + IM bridge for AI coding tools.

Three features, use any combination:
- **`tlive <cmd>`** — wrap any command with a web-accessible terminal
- **`/tlive`** — chat with Claude Code / Codex from Telegram, Discord, or Feishu
- **Hook Approval** — approve Claude Code tool permissions from your phone

## Install

```bash
npm install -g tlive
```

## Feature 1: Web Terminal

Wrap any long-running command. Access the terminal from your phone's browser.

```bash
tlive claude                  # Wrap Claude Code
tlive python train.py         # Wrap a training script
tlive npm run build           # Wrap a build
```

```
$ tlive claude --model opus

  TLive Web UI:
    Local:   http://localhost:8080?token=abc123
    Network: http://192.168.1.100:8080?token=abc123
  Session: claude (ID: a1b2c3)
```

Multiple sessions in one dashboard. Daemon auto-starts, auto-shuts down after 15 minutes idle.

## Feature 2: IM Bridge

Chat with Claude Code from your phone. Start new tasks, get streaming responses with real-time tool visibility.

```bash
tlive setup                   # Configure IM platforms
tlive install skills --claude  # Install to Claude Code

# Then in Claude Code:
/tlive                        # Start Bridge
```

```
You (Telegram):  "Fix the login bug in auth.ts"

TLive (TG):      🔍 Grep → 📖 Read → ✏️ Edit → 🖥️ Bash
                  ──────────────────
                  I found the issue. The token
                  validation was missing the expiry check...

TLive (TG):      ✅ Task Complete
                  Fixed auth.ts, all tests pass
                  📊 12.3k/8.1k tok | $0.08 | 2m 34s
```

**Verbose levels:** Control how much detail you see with `/verbose 0|1|2` (quiet/normal/detailed).

## Feature 3: Hook Approval (Killer Feature)

Approve Claude Code tool permissions from your phone. Never get blocked by a `[y/N]` prompt again.

**How it works:**

```
You run Claude Code in terminal (normal usage, no wrapper needed)
  │
  ├── Claude wants to edit a file
  │   → PreToolUse Hook fires
  │   → Go Core receives, holds request
  │   → Bridge polls, sends to Telegram:
  │
  │   🔒 Permission Required (Local Claude Code)
  │   Tool: Bash
  │   ┌──────────────────────────┐
  │   │ rm -rf node_modules &&   │
  │   │ npm install              │
  │   └──────────────────────────┘
  │   [✅ Allow]  [❌ Deny]
  │
  ├── You tap [Allow] on phone
  │   → Bridge resolves → Go Core returns
  │   → Claude Code continues
  │
  └── You walk away. Claude keeps working.
      Phone buzzes only when approval needed.
```

**Setup (one-time):**

```bash
# 1. Start Go Core (receives hooks)
tlive setup

# 2. Add hooks to Claude Code settings
# ~/.claude/settings.json
{
  "hooks": {
    "PreToolUse": [{
      "type": "command",
      "command": "~/.tlive/bin/hook-handler.sh",
      "timeout": 300000
    }],
    "Notification": [{
      "type": "command",
      "command": "~/.tlive/bin/notify-handler.sh",
      "timeout": 5000
    }]
  }
}
```

**Safe by design:**
- Hook script checks if Go Core is running — if not, passes through (zero impact)
- Timeout defaults to **deny** (not allow) — security first
- Shows exact tool name and command before you approve
- Works with any Claude Code session, no wrapper needed

**Pause when you're at your desk:**

```bash
tlive hooks pause              # Auto-allow everything, no notifications
tlive hooks resume             # Back to normal IM approval
```

Or from your phone: send `/hooks pause` or `/hooks resume` in IM.

## How the Three Features Relate

```
┌─ Feature 1: Web Terminal ──────┐
│ tlive claude                    │
│ → PTY + Web UI + QR code       │
│ Access: browser                 │
└─────────────────────────────────┘

┌─ Feature 2: IM Bridge ─────────┐
│ /tlive (Claude Code skill)     │
│ → Agent SDK + Telegram/Discord │
│ → New tasks from phone         │
│ Access: IM app                  │
└─────────────────────────────────┘

┌─ Feature 3: Hook Approval ─────┐
│ Claude Code hooks → Go Core    │
│ → Bridge polls → IM buttons    │
│ → Approve existing tasks       │
│ Access: IM app                  │
└─────────────────────────────────┘

Features 2 & 3 need Go Core running.
Bridge detects Go Core → IM messages include web terminal link.
Each feature works independently.
```

## Supported Platforms

| | Telegram | Discord | Feishu |
|---|----------|---------|--------|
| IM Bridge (Feature 2) | ✅ | ✅ | ✅ |
| Hook Approval (Feature 3) | ✅ | ✅ | ✅ |
| Streaming responses | Edit-based | Edit-based | CardKit v2 |
| Tool visibility | ✅ | ✅ | ✅ |
| Typing indicator | ✅ | ✅ | — |
| Permission buttons | Inline keyboard | Button components | Interactive card |

## Commands

### CLI

```bash
tlive <cmd>                # Web terminal (Feature 1)
tlive stop                 # Stop daemon
tlive setup                # Configure IM platforms
tlive install skills       # Install to Claude Code / Codex
tlive hooks                # Show hook status
tlive hooks pause           # Pause hooks (auto-allow)
tlive hooks resume          # Resume hooks (IM approval)
```

### Claude Code Skill

```
/tlive                     # Start IM Bridge (Feature 2)
/tlive setup               # Configure IM
/tlive stop                # Stop Bridge
/tlive status              # Check status
/tlive doctor              # Diagnostics

/verbose 0|1|2             # Set detail level (quiet/normal/detailed)
/new                       # Start new conversation
/hooks pause|resume        # Toggle hook approval
```

## Configuration

Single config file `~/.tlive/config.env` (created by `tlive setup`):

```env
TL_PORT=8080
TL_TOKEN=auto-generated
TL_HOST=127.0.0.1
TL_PUBLIC_URL=https://example.com

TL_ENABLED_CHANNELS=telegram,discord
TL_TG_BOT_TOKEN=...
TL_TG_CHAT_ID=...
TL_TG_ALLOWED_USERS=...
TL_DC_BOT_TOKEN=...
TL_FS_APP_ID=...
TL_FS_APP_SECRET=...
```

## Architecture

```
                    ┌──────────────────────┐
                    │   Claude Code (local) │
                    │                      │
                    │  PreToolUse Hook ────────────┐
                    │  Notification Hook ──────────┤
                    └──────────────────────┘       │
                                                   ▼
┌─ Go Core (tlive) ───────────────────────────────────────────┐
│                                                              │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────────────┐│
│  │ PTY Mgr  │  │ Web UI       │  │ Hook Manager           ││
│  │ (wrap    │  │ (dashboard + │  │ (receive hooks,        ││
│  │  cmds)   │  │  xterm.js)   │  │  long-poll, resolve)   ││
│  └──────────┘  └──────────────┘  └────────────────────────┘│
│                                                              │
│  HTTP API: /api/status, /api/sessions,                       │
│            /api/hooks/permission, /api/hooks/pending          │
│  WebSocket: /ws/session/:id, /ws/status                      │
└──────────────────────────┬───────────────────────────────────┘
                           │ Bridge polls /api/hooks/pending
                           ▼
┌─ Node.js Bridge ────────────────────────────────────────────┐
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐ │
│  │ Agent SDK   │  │ Telegram     │  │ Hook Poll          │ │
│  │ (new tasks  │  │ Discord      │  │ (forward to IM,    │ │
│  │  from IM)   │  │ Feishu       │  │  resolve on click) │ │
│  └─────────────┘  └──────────────┘  └────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │  Your Phone  │
                    │  (IM app)    │
                    └──────────────┘
```

## Development

```bash
# Go Core
cd core && go build -o tlive ./cmd/tlive/ && go test ./...

# Bridge
cd bridge && npm install && npm run build && npm test
```

### Project Structure

```
tlive/
├── SKILL.md                # Claude Code / Codex skill
├── config.env.example
├── core/                   # Go → tlive binary
│   ├── cmd/tlive/          # CLI (web terminal, stop, setup, install)
│   ├── internal/
│   │   ├── daemon/         # HTTP server, sessions, hooks manager
│   │   ├── server/         # WebSocket handlers
│   │   ├── session/        # Session state + output buffer
│   │   ├── hub/            # Broadcast hub
│   │   └── pty/            # PTY (Unix + Windows ConPTY)
│   └── web/                # Embedded Web UI
├── bridge/                 # Node.js → Bridge daemon
│   └── src/
│       ├── providers/      # Claude Agent SDK
│       ├── channels/       # Telegram, Discord, Feishu adapters
│       ├── engine/         # Conversation engine, bridge manager, streaming
│       ├── permissions/    # Permission gateway + broker
│       ├── delivery/       # Chunking, retry, rate limiting
│       └── markdown/       # Per-platform rendering
├── scripts/
│   ├── hook-handler.sh     # PreToolUse hook → Go Core
│   ├── notify-handler.sh   # Notification hook → Go Core
│   ├── daemon.sh           # Bridge process management
│   └── statusline.sh       # Claude Code status line
├── package.json            # npm: tlive
└── docker-compose.yml
```

## Security

- Default bind `127.0.0.1` (explicit `--host 0.0.0.0` for LAN)
- Auto-generated bearer token
- Hook timeout defaults to **deny** (not allow)
- IM user whitelists per platform
- Secret redaction in logs
- `chmod 600` on config.env
- Environment isolation for Claude CLI subprocess

## License

MIT
