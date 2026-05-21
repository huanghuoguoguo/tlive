# tlive

[![CI](https://github.com/huanghuoguoguo/tlive/actions/workflows/ci.yml/badge.svg)](https://github.com/huanghuoguoguo/tlive/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Control Claude Code from Feishu/Lark** — send tasks from your phone, watch progress in real time, and approve Claude Code permissions remotely.

## Scope

tlive is intentionally focused on one workflow:

- **IM channel:** Feishu/Lark
- **Agent runtime:** Claude Code via `@anthropic-ai/claude-agent-sdk`
- **Interaction model:** Feishu cards for streaming progress, questions, and permission approvals

The project no longer carries Telegram, QQ Bot, Codex, or generic provider/channel runtime layers.

## Features

- Feishu/Lark chat to Claude Code sessions
- Real-time progress cards with thinking, tool calls, summaries, and final output
- Remote permission approval, including session-level allow rules
- AskUserQuestion and deferred tool interactions in Feishu cards
- Claude Code session scanning and resume from `~/.claude/projects/`
- Per-chat working directory with `/cd`, `/pwd`, `/new`, and `/sessions`
- Automation webhooks for external prompt injection

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
git clone https://github.com/huanghuoguoguo/tlive.git
cd tlive
claude
```

Then ask Claude Code:

```text
help me setup tlive
```

Claude Code will guide you through Feishu app credentials, local config, and bridge startup.

## Architecture

```text
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│   Feishu    │────▶│  tlive Bridge    │◀────│  Claude Code│
│   / Lark    │     │  TypeScript      │     │  sessions   │
└─────────────┘     └──────────────────┘     └─────────────┘
```

The bridge runs locally, connects to Feishu through the Feishu/Lark SDK long connection, and drives Claude Code through the Claude Agent SDK.

## IM Commands

Send a normal message to start or continue work:

```text
Fix the login bug in auth.ts
```

Common commands:

| Command | Description |
|---------|-------------|
| `/new` | Start a new Claude Code conversation |
| `/sessions` | List Claude Code sessions in the current directory |
| `/session <n>` | Switch to a listed session |
| `/stop` | Interrupt current execution |
| `/perm on\|off` | Toggle permission prompts |
| `/cd <path>` | Change working directory |
| `/pwd` | Show current working directory |
| `/help` | Show commands |

## Settings

Agent settings are loaded per conversation from the session working directory:

| Priority | Source | Path |
|----------|--------|------|
| Low | `user` | `~/.claude/settings.json` |
| Medium | `project` | `<cwd>/.claude/settings.json` |
| High | `local` | `<cwd>/.claude/settings.local.json` |

Configure with:

```env
TL_AGENT_SETTINGS=user,project,local
```

Existing `TL_CLAUDE_SETTINGS` configs are still accepted as an alias.

## Documentation

- [Getting Started](docs/getting-started.md)
- [Feishu Setup](docs/setup-feishu.md)
- [Configuration](docs/configuration.md)
- [Troubleshooting](docs/troubleshooting.md)

## License

MIT
