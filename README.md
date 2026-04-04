# tlive

[![CI](https://github.com/huanghuoguoguo/tlive/actions/workflows/ci.yml/badge.svg)](https://github.com/huanghuoguoguo/tlive/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[中文文档](README_CN.md)

> **Fork of [y49/tlive](https://github.com/y49/tlive)** — Claude-only version with enhancements.

**Control Claude Code from your phone** — Send tasks via Telegram, Discord, Feishu, or QQ Bot. Watch progress in real-time. Approve permissions remotely.

## Changes from Original

- **Removed Codex support** — Claude-only, simplified codebase
- **Enhanced session scanner** — Efficient tail reading (32KB) with 5s cache
- **Fixed O(n) binding lookup** — Direct session ID indexing
- **Added `/bash`, `/cd`, `/pwd` commands** — More shell control
- **Improved daemon mode** — Auto-start on demand, no manual activation needed

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.sh | bash
```

## Quick Start

```bash
# 1. Configure (interactive wizard)
tlive setup

# 2. Register Claude Code integration
tlive install skills

# 3. Start daemon
tlive start
```

Then run `/tlive` in Claude Code. You can now message Claude from your phone.

## Features

| Feature | Description |
|---------|-------------|
| **IM Chat** | Phone → Claude → Streaming response with tool visibility |
| **Permission Approval** | Approve tool executions from your phone |
| **Web Terminal** | `tlive <cmd>` wraps any command, view in browser |

## Daemon Mode

`tlive start` runs as a background service. Auto-starts on boot, stays running. No manual activation needed — Claude wakes it up when needed.

```bash
tlive start    # Start daemon
tlive stop     # Stop
tlive status   # Check status
```

## IM Commands

Send directly in Telegram/Discord/Feishu/QQ Bot:

```
Fix the login bug in auth.ts
```

Claude executes and returns results. Key commands:

| Command | Description |
|---------|-------------|
| `/new` | New conversation |
| `/stop` | Interrupt execution |
| `/verbose 0\|1` | Detail level (0=concise, 1=show tool calls) |
| `/perm on\|off` | Toggle permission prompts |
| `/cd <path>` | Change working directory |
| `/bash <cmd>` | Execute shell command |

## Platform Setup

| Platform | Setup Time | Notes |
|----------|------------|-------|
| [Telegram](docs/setup-telegram.md) | ~2 min | Best for individuals |
| [Discord](docs/setup-discord.md) | ~5 min | For teams |
| [Feishu](docs/setup-feishu.md) | ~15 min | For Chinese teams |
| [QQ Bot](docs/setup-qqbot.md) | ~5 min | For QQ users |

## Claude Code Configuration

tlive reads Claude Code settings from these sources (configure via `TL_CLAUDE_SETTINGS`):

| Source | Path | Purpose |
|--------|------|---------|
| `user` | `~/.claude/settings.json` | Global auth and model |
| `project` | `.claude/settings.json` | Project rules, MCP |
| `local` | `.claude/settings.local.json` | Local overrides |

Example `.claude/settings.local.json`:
```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "your-api-key",
    "ANTHROPIC_BASE_URL": "https://api.anthropic.com"
  }
}
```

Then in `~/.tlive/config.env`:
```env
TL_CLAUDE_SETTINGS=user,project,local
```

## Documentation

- [Full Getting Started Guide](docs/getting-started.md)
- [Configuration Options](docs/configuration.md)
- [Troubleshooting](docs/troubleshooting.md)

## License

MIT