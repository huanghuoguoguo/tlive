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
# 1. Clone the repo
git clone https://github.com/huanghuoguoguo/tlive.git
cd tlive

# 2. Start Claude Code in the project
claude

# 3. Say "help me setup tlive"
# Claude Code will guide you through all configuration
```

That's it! Claude Code will help you:
- Choose IM platforms (Telegram/Discord/Feishu/QQ Bot)
- Get platform credentials
- Configure Claude Code integration
- Start the service

## Features

| Feature | Required | Description |
|---------|----------|-------------|
| **IM Chat** | Yes | Phone → Claude → Streaming response with tool visibility |
| **Permission Approval** | Yes | Approve tool executions from your phone |
| **Web Terminal** | No | `tlive <cmd>` wraps any command, view in browser |

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│   Telegram  │     │                  │     │             │
├─────────────┤     │   Bridge (TS)    │     │  ~/.claude  │
│   Discord   │────▶│   IM Adapter     │◀────│   sessions  │
├─────────────┤     │                  │     │             │
│   Feishu    │     │   (Required)     │     │  (scanned)  │
├─────────────┤     └──────────────────┘     └─────────────┘
│   QQ Bot    │
└─────────────┘

┌──────────────────┐
│   Core (Go)      │     Optional: `tlive <cmd>` web terminal
│   (Optional)     │     Not needed for IM features
└──────────────────┘
```

**Bridge** (Required): Connects IM platforms to Claude Code by scanning session files.

**Core** (Optional): Provides web terminal feature. Not needed for IM chat or permission approvals.

## IM Commands

Send directly in Telegram/Discord/Feishu/QQ Bot:

```
Fix the login bug in auth.ts
```

Claude executes and returns results. Key commands:

| Command | Description |
|---------|-------------|
| `/new` | New conversation |
| `/sessions` | List sessions in current directory |
| `/session <n>` | Switch to session #n |
| `/stop` | Interrupt execution |
| `/verbose 0\|1` | Detail level (0=concise, 1=show tool calls) |
| `/perm on\|off` | Toggle permission prompts |
| `/cd <path>` | Change working directory |
| `/bash <cmd>` | Execute shell command |
| `/help` | Show all commands |

## Settings

Claude Code settings are loaded per conversation from the session's working directory:

| Priority | Source | Path |
|----------|--------|------|
| Low | `user` | `~/.claude/settings.json` |
| Medium | `project` | `<cwd>/.claude/settings.json` |
| **High** | `local` | `<cwd>/.claude/settings.local.json` |

Configure via `TL_CLAUDE_SETTINGS=user,project,local` (order = priority). Changes apply to new conversations.

## Documentation

- [Full Getting Started Guide](docs/getting-started.md)
- [Configuration Options](docs/configuration.md)
- [Troubleshooting](docs/troubleshooting.md)

## License

MIT