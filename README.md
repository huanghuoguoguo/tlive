# TLive

[中文文档](README_CN.md)

Terminal live monitoring + IM bridge for AI coding tools.

Two independent features, use either or both:
- **`tlive <cmd>`** — wrap any command with a web-accessible terminal
- **`/tlive`** — chat with Claude Code / Codex from Telegram, Discord, or Feishu

## Install

```bash
npm install -g tlive
```

## Feature 1: Web Terminal (`tlive <cmd>`)

Wrap any long-running command. Access the terminal from your phone's browser.

```bash
tlive claude                  # Wrap Claude Code
tlive python train.py         # Wrap a training script
tlive npm run build           # Wrap a build
```

Opens a web terminal at `http://localhost:8080?token=xxx` — view and interact from any device.

```
$ tlive claude --model opus

  TLive Web UI:
    Local:   http://localhost:8080?token=abc123
    Network: http://192.168.1.100:8080?token=abc123
  Session: claude (ID: a1b2c3)
```

Multiple sessions in one dashboard:
```bash
# Terminal 1
tlive claude

# Terminal 2 (auto-joins existing daemon)
tlive npm run dev
```

Daemon auto-starts on first `tlive <cmd>`, auto-shuts down after 15 minutes idle.

## Feature 2: IM Bridge (`/tlive`)

Chat with Claude Code from your phone. Get streaming responses, approve tool permissions with buttons.

```bash
# First: configure IM platforms
tlive setup

# Install as Claude Code / Codex skill
tlive install skills --claude
tlive install skills --codex

# Then in Claude Code:
/tlive                    # Start Bridge
/tlive setup              # Reconfigure
/tlive stop               # Stop Bridge
```

### IM Interaction

```
You (Telegram):  "Fix the login bug in auth.ts"

TLive (TG):      🔒 Permission Required
                  Tool: Edit | File: src/auth.ts
                  [Allow] [Allow Session] [Deny]

You:              Tap [Allow]

TLive (TG):      ✅ Task Complete
                  Fixed auth.ts, all tests pass
                  📊 12.3k/8.1k tok | $0.08 | 2m 34s
```

If the web terminal is also running, IM messages include a link:
```
🖥 View Terminal → http://localhost:8080/terminal.html?id=abc
```

### Supported Platforms

| | Telegram | Discord | Feishu |
|---|----------|---------|--------|
| Streaming | Edit-based, 700ms | Edit-based, 1500ms | CardKit v2, 200ms |
| Permission buttons | Inline keyboard | Button components | Interactive card |
| Image | Yes | Yes | Yes |

## Commands

### CLI (Go binary)

```bash
tlive <cmd>                # Web terminal
tlive stop                 # Stop daemon
tlive setup                # Configure
tlive install skills       # Install to Claude Code / Codex
```

### Claude Code Skill

```
/tlive                     # Start IM Bridge
/tlive setup               # Configure IM
/tlive stop                # Stop Bridge
/tlive status              # Check status
/tlive doctor              # Diagnostics
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
TL_DC_BOT_TOKEN=...
TL_FS_APP_ID=...
TL_FS_APP_SECRET=...
```

## Architecture

```
┌─ Feature 1: Web Terminal ──────────┐    ┌─ Feature 2: IM Bridge ──────────┐
│                                     │    │                                  │
│  tlive claude                       │    │  /tlive (Claude Code skill)      │
│    └── Go binary                    │    │    └── Node.js Bridge            │
│        ├── PTY wrapper              │    │        ├── Agent SDK             │
│        ├── Web UI (xterm.js)        │    │        ├── Telegram adapter      │
│        ├── HTTP API                 │    │        ├── Discord adapter       │
│        └── WebSocket                │    │        └── Feishu adapter        │
│                                     │    │                                  │
│  Access: browser                    │    │  Access: phone IM app            │
│                                     │    │                                  │
└─────────────────────────────────────┘    └──────────────────────────────────┘
              │                                          │
              └───── Bridge detects Go daemon ───────────┘
                     → IM messages include web link
```

Two independent components. Bridge works without Go Core. Go Core works without Bridge.

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
├── SKILL.md              # Claude Code / Codex skill
├── config.env.example
├── core/                  # Go → tlive binary
│   ├── cmd/tlive/
│   ├── internal/          # daemon, server, session, hub, pty
│   └── web/               # Embedded Web UI
├── bridge/                # Node.js → Bridge daemon
│   └── src/               # providers, channels, engine, permissions, delivery
├── scripts/               # CLI entry, status line
├── package.json           # npm: tlive
└── docker-compose.yml
```

## Security

- Default bind `127.0.0.1` (explicit `--host 0.0.0.0` for LAN)
- Auto-generated bearer token
- Scoped tokens for web links (1h TTL, read-only)
- IM user whitelists
- Secret redaction in logs
- `chmod 600` on config.env

## License

MIT
