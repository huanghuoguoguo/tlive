# tlive

[![CI](https://github.com/huanghuoguoguo/tlive/actions/workflows/ci.yml/badge.svg)](https://github.com/huanghuoguoguo/tlive/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Control Claude Code and Codex from Feishu/Lark** — send tasks from your phone, watch progress in real time, and manage local agent sessions remotely.

## Scope

tlive is intentionally focused on one workflow:

- **IM channel:** Feishu/Lark
- **Agent runtimes:** Claude Code and Codex, driven through their local CLI/SDK runtimes
- **Interaction model:** Feishu cards for the workbench, topic sessions, streaming progress, questions, and approvals

The project no longer carries Telegram, QQ Bot, or generic multi-channel runtime layers.

## Features

- Feishu/Lark chat to Claude Code or Codex sessions
- Workbench for creating Claude/Codex topic sessions, switching directories, and resuming history
- Real-time progress cards with thinking, tool calls, summaries, and final output
- Claude Code permission approval, including session-level allow rules
- AskUserQuestion and deferred tool interactions for providers that support them
- Session scanning and resume from `~/.claude/projects/` and TLive-created Codex sessions under `~/.codex/sessions`
- File and image forwarding to providers that support attachments
- Automation webhooks for external prompt injection
- Release-based self-upgrade with `tlive upgrade`

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

Run the one-time setup and start the bridge:

```bash
tlive setup
tlive start
```

Then send `/tlive` in Feishu/Lark to open the workbench.

TLive SDK sessions automatically load the bundled MCP server for agent-side callbacks.
The MCP server exposes tools such as
`tlive_send_file`, `tlive_send_image`, `tlive_inject_prompt`, and `tlive_status`.

## Architecture

```text
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│   Feishu    │────▶│  tlive Bridge    │◀────│ Claude/Codex│
│   / Lark    │     │  TypeScript      │     │   sessions  │
└─────────────┘     └──────────────────┘     └─────────────┘
```

The bridge runs locally, connects to Feishu through the Feishu/Lark SDK long connection, and drives the selected local agent provider. Claude Code is integrated through `@anthropic-ai/claude-agent-sdk`; Codex is integrated through `@openai/codex-sdk`.

## IM Commands

The main chat is a command-only workbench. Use `/tlive` or `/home` to open it, then start
Claude/Codex sessions from the client blocks. Each new session opens as its own Feishu/Lark topic.

Send normal task messages inside an agent topic to start or continue work:

```text
Fix the login bug in auth.ts
```

Normal text sent in the main chat will not start an agent session. If more than one execution
client is connected, use `/use <client-id>` in the workbench to choose the default client. When
there is exactly one client, TLive selects it automatically.

Public workbench commands are intentionally small so agent slash commands such as `/model` can pass through to Claude Code or Codex inside topics.

| Command | Description |
|---------|-------------|
| `/tlive` | Open the TLive workbench |
| `/home` | Alias for the workbench |
| `/use <client-id>` | Set the default execution client for the workbench |
| `/stop` | Interrupt current execution |

Other TLive operations are exposed in the workbench as buttons or command input, including new Claude/Codex sessions, session history, directory changes, permission mode, diagnostics, restart, and upgrade.

## Settings

Choose the default provider:

```env
TL_PROVIDER=claude
# or
TL_PROVIDER=codex
```

The workbench shows new-session buttons only for detected local CLIs. Install `claude` for Claude Code sessions and `codex` for Codex sessions.

### Remote Workers

One machine can run the Feishu bot and scheduler while worker machines connect over WebSocket and run local Claude/Codex sessions.
The server host is also exposed as a local execution client by default. Set `TL_LOCAL_CLIENT_ENABLED=false` if the server should only coordinate remote clients.

Server machine:

```env
TL_REMOTE_SERVER_ENABLED=true
TL_REMOTE_TOKEN=change-this-token
TL_REMOTE_PROVIDERS=claude,codex
```

```bash
tlive server
```

Worker machine:

```bash
tlive client --server ws://your-server:8787/tlive --token change-this-token --workspace /path/to/project
```

Codex runtime options:

```env
TL_CODEX_MODEL=
TL_CODEX_PATH=
TL_CODEX_SANDBOX_MODE=workspace-write
TL_CODEX_APPROVAL_POLICY=on-request
TL_CODEX_SKIP_GIT_REPO_CHECK=false
TL_CODEX_REASONING_EFFORT=
TL_CODEX_NETWORK_ACCESS=
TL_CODEX_WEB_SEARCH=
```

Claude Code setting sources are loaded per conversation from the session working directory:

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

## Upgrade

Upgrade to the latest stable release:

```bash
tlive upgrade
```

Upgrade to a specific release, including beta/prerelease versions when available:

```bash
tlive upgrade 0.13.7
tlive upgrade 0.13.8-beta.1
```

## Documentation

- [Getting Started](docs/getting-started.md)
- [Feishu Setup](docs/setup-feishu.md)
- [Configuration](docs/configuration.md)
- [Troubleshooting](docs/troubleshooting.md)

## License

MIT
