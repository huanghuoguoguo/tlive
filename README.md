# tlive

[![npm version](https://img.shields.io/npm/v/tlive)](https://www.npmjs.com/package/tlive)
[![CI](https://github.com/y49/tlive/actions/workflows/ci.yml/badge.svg)](https://github.com/y49/tlive/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[中文文档](README_CN.md)

**Terminal Live** — monitor and chat with AI coding agents (Claude Code, Codex) from Telegram, Discord & Feishu.

Three features, use any combination:

| Feature | What it does | Access from |
|---------|-------------|-------------|
| **Web Terminal** | `tlive <cmd>` — wrap any command with a web-accessible terminal | Browser / Phone |
| **IM Bridge** | `/tlive` — chat with Claude Code from your phone | Telegram / Discord / Feishu |
| **Hook Approval** | Approve Claude Code permissions from your phone | Telegram / Discord / Feishu |

<!-- TODO: Add hero screenshot/GIF here -->
<!-- ![tlive demo](docs/images/demo.gif) -->

## Quick Start

```bash
# 1. Install
npm install -g tlive

# 2. Configure your IM platform (interactive wizard)
tlive setup

# 3. Register hooks + Claude Code skill
tlive install skills

# 4. In Claude Code, start the bridge
/tlive
```

> **Recommended:** Run `/tlive setup` inside Claude Code for an AI-guided setup experience that walks you through each step.

Platform setup guides: [Telegram](docs/setup-telegram.md) · [Discord](docs/setup-discord.md) · [Feishu](docs/setup-feishu.md) · [Full Getting Started Guide](docs/getting-started.md)

## Web Terminal

Wrap any long-running command. Access from your phone's browser.

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

<!-- TODO: Add web terminal screenshot -->
<!-- ![Web Terminal](docs/images/web-terminal.png) -->

## IM Bridge

Chat with Claude Code from your phone. Start new tasks, get streaming responses with real-time tool visibility.

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

**Verbose levels:** `/verbose 0|1|2` — quiet (final answer only) / normal (tool names) / detailed (tool names + inputs).

<!-- TODO: Add IM bridge screenshot -->
<!-- ![IM Bridge](docs/images/im-bridge.png) -->

## Hook Approval

Approve Claude Code tool permissions from your phone. Never get blocked by a `[y/N]` prompt again.

```
Claude Code runs normally in your terminal (no wrapper needed)
  │
  ├── Claude wants to run a command
  │   → Hook fires → Go Core receives → Bridge sends to your phone:
  │
  │   🔒 Permission Required
  │   Tool: Bash
  │   ┌──────────────────────────┐
  │   │ rm -rf node_modules &&   │
  │   │ npm install              │
  │   └──────────────────────────┘
  │   [✅ Allow]  [❌ Deny]
  │
  ├── You tap [Allow] → Claude Code continues
  │
  └── Walk away. Claude keeps working.
      Phone buzzes only when approval needed.
```

**Safe by design:**
- Timeout defaults to **deny** (not allow)
- Shows exact tool name and command before you approve
- Hook script checks if Go Core is running — if not, passes through (zero impact on normal usage)
- Works with any Claude Code session, no wrapper needed

**Pause when you're at your desk:**

```bash
tlive hooks pause              # Auto-allow everything
tlive hooks resume             # Back to IM approval
```

<!-- TODO: Add hook approval screenshot -->
<!-- ![Hook Approval](docs/images/hook-approval.png) -->

## Supported Platforms

| | Telegram | Discord | Feishu |
|---|----------|---------|--------|
| IM Bridge | ✅ | ✅ | ✅ |
| Hook Approval | ✅ | ✅ | ✅ |
| Streaming responses | Edit-based | Edit-based | CardKit v2 |
| Tool visibility | ✅ | ✅ | ✅ |
| Typing indicator | ✅ | ✅ | — |
| Reactions | ✅ | ✅ | ✅ |
| Permission buttons | Inline keyboard | Button components | Interactive card |
| Text approval (`allow`/`deny`) | ✅ | ✅ | ✅ |
| Thread/Topic support | Forum topics | Auto-thread | — |
| Pairing mode | ✅ | — | — |
| Webhook mode | ✅ | — | WebSocket |

## Commands

### CLI

```bash
tlive <cmd>                # Web terminal
tlive setup                # Configure IM platforms
tlive install skills       # Register hooks + Claude Code skill
tlive start                # Start Bridge daemon
tlive stop                 # Stop daemon
tlive status               # Check status
tlive logs [N]             # Show last N lines of bridge log
tlive doctor               # Run diagnostics
tlive hooks                # Show hook status
tlive hooks pause          # Pause hooks (auto-allow)
tlive hooks resume         # Resume hooks (IM approval)
```

### Claude Code Skill

```
/tlive                     # Start IM Bridge
/tlive setup               # AI-guided configuration
/tlive stop                # Stop Bridge
/tlive status              # Check status
/tlive doctor              # Diagnostics

/verbose 0|1|2             # Set detail level
/new                       # Start new conversation
/hooks pause|resume        # Toggle hook approval
/approve <code>            # Approve Telegram pairing
/pairings                  # List pending pairings
```

> **IM Commands:** These slash commands also appear in Telegram's native bot menu automatically.

## Configuration

Single config file `~/.tlive/config.env` (created by `tlive setup`):

```env
TL_PORT=8080
TL_TOKEN=auto-generated
TL_HOST=0.0.0.0
TL_PUBLIC_URL=https://example.com

TL_ENABLED_CHANNELS=telegram,discord

# Telegram
TL_TG_BOT_TOKEN=...
TL_TG_CHAT_ID=...
TL_TG_REQUIRE_MENTION=true        # @bot required in groups
TL_TG_DISABLE_LINK_PREVIEW=true   # cleaner messages

# Discord
TL_DC_BOT_TOKEN=...

# Feishu
TL_FS_APP_ID=...
TL_FS_APP_SECRET=...
```

See [config.env.example](config.env.example) for all options.

### Remote Access (frp / tunnels)

To access the web terminal from outside your LAN (e.g. via frpc, Cloudflare Tunnel, ngrok):

1. Forward local port `8080` (or your `TL_PORT`) through the tunnel
2. Set `TL_PUBLIC_URL` to your tunnel domain:
   ```env
   TL_PUBLIC_URL=https://your-domain.com
   ```
   IM messages will use this URL for web terminal links instead of the LAN IP.

**Security notes:** The tunnel exposes full terminal access. Make sure:
- `TL_TOKEN` is set (auto-generated by `tlive setup`) — all requests require this bearer token
- IM user whitelists are configured (`TL_TG_ALLOWED_USERS`, `TL_DC_ALLOWED_USERS`, etc.)
- Use HTTPS on the tunnel side (frps/Cloudflare handle this automatically)

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

- Default bind `0.0.0.0` (LAN-accessible for phone QR scan)
- Auto-generated bearer token
- Hook timeout defaults to **deny** (not allow)
- IM user whitelists per platform (or pairing mode for Telegram)
- Bot permission probing on startup (warns about missing permissions)
- Secret redaction in logs
- `chmod 600` on config.env
- Environment isolation for Claude CLI subprocess

## License

MIT
