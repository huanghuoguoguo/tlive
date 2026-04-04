# tlive

[![CI](https://github.com/huanghuoguoguo/tlive/actions/workflows/ci.yml/badge.svg)](https://github.com/huanghuoguoguo/tlive/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[中文文档](README_CN.md)

**Control Claude Code from your phone** — Send tasks via Telegram, Discord, or Feishu. Watch progress in real-time. Approve permissions remotely.

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

Send directly in Telegram/Discord/Feishu:

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

## Documentation

- [Full Getting Started Guide](docs/getting-started.md)
- [Configuration Options](docs/configuration.md)
- [Troubleshooting](docs/troubleshooting.md)

## License

MIT