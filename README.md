# tlive

[![CI](https://github.com/huanghuoguoguo/tlive/actions/workflows/ci.yml/badge.svg)](https://github.com/huanghuoguoguo/tlive/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[中文文档](README_CN.md)

> **Fork of [y49/tlive](https://github.com/y49/tlive)** — Claude-only version with enhancements.

**Control Claude Code from your phone** — Send tasks via Telegram, Feishu, or QQ Bot. Watch progress in real-time. Approve permissions remotely.

## Changes from Original

### Architecture Simplified
- **Removed Go Core + Web Terminal** — Pure TypeScript, no web terminal, IM-only interaction
- **Removed Codex + Discord** — Claude-only, Discord adapter removed, cleaner codebase

### Feishu Deep Optimization
- **Collapsible panels** — Thinking & tool calls fold/unfold, long content doesn't clutter screen
- **Real-time progress** — Thinking content pushed live, tool execution status instant update
- **Enhanced permission cards** — Allow Always (auto-allow in session), AskUserQuestion multi-select
- **Table limit handling** — Large tables auto-truncated to avoid Feishu API errors

### Session Management Enhanced
- **Session scanning** — Scan `~/.claude/projects/`, list recent sessions, resume any
- **Efficient tail reading** — 32KB tail read for latest message, 5s cache avoids repeated I/O
- **Fixed O(n) lookup** — Direct session ID indexing, no iteration
- **Added `/cd`, `/pwd` commands** — Per-chat directory control

### Agent Capabilities Extended
- **Proactive file sending** — Agent can send files (images, PDFs) to IM via REST API
- **Cron job API** — Agent can create/manage scheduled tasks
- **Entropy control tools** — Dead code detection, duplicate identification, code quality tools

### UX Improvements
- **Compact Bash display** — Command output in single-line format
- **Improved daemon mode** — Auto-start on demand, no manual activation needed

## Install

Linux / macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.sh | bash
```

Windows PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "$tmp = Join-Path $env:TEMP 'tlive-install.ps1'; Invoke-WebRequest 'https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.ps1' -UseBasicParsing -OutFile $tmp; & $tmp"
```

Verify:

```bash
tlive --help
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
- Choose IM platforms (Telegram/Feishu/QQ Bot)
- Get platform credentials
- Configure Claude Code integration
- Start the service

## Features

| Feature | Required | Description |
|---------|----------|-------------|
| **IM Chat** | Yes | Phone → Claude → Streaming response with tool visibility |
| **Permission Approval** | Yes | Approve tool executions from your phone |

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│   Telegram  │     │                  │     │             │
├─────────────┤     │   Bridge (TS)    │     │  ~/.claude  │
│   Feishu    │────▶│   IM Adapter     │◀────│   sessions  │
├─────────────┤     │                  │     │             │
│   QQ Bot    │     │                  │     │  (scanned)  │
└─────────────┘     └──────────────────┘     └─────────────┘
```

**Bridge**: TypeScript service that connects IM platforms to Claude Code by scanning session files. Includes built-in `tlive` CLI for web terminal feature.

## IM Commands

Send directly in Telegram/Feishu/QQ Bot:

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
| `/perm on\|off` | Toggle permission prompts |
| `/cd <path>` | Change working directory |
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
