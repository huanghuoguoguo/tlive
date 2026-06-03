# tlive

[![CI](https://github.com/huanghuoguoguo/tlive/actions/workflows/ci.yml/badge.svg)](https://github.com/huanghuoguoguo/tlive/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![LINUX DO](https://img.shields.io/badge/LINUX-DO-FFB003?style=flat-square)](https://linux.do)

**Feishu/Lark-native remote AI development workbench** for Claude Code, Codex, and Pi.
Control local or remote agent nodes from chat, keep each task in a topic, and share agent
sessions in groups.

## Scope

tlive is intentionally focused on one workflow:

- **IM channel:** Feishu/Lark
- **Agent runtimes:** Claude Code, Codex, and Pi, driven through their local SDK runtimes
- **Interaction model:** Feishu cards for the workbench, topic sessions, streaming progress, questions, and approvals
- **Collaboration model:** the main chat is a workbench; every agent task runs in a
  Feishu/Lark topic that can be pinned, resumed, or shared in a group

The project no longer carries Telegram, QQ Bot, or generic multi-channel runtime layers.

## Features

- Feishu/Lark chat to Claude Code, Codex, or Pi sessions
- Feishu-native workbench for selecting execution nodes, browsing directories, creating
  Claude/Codex/Pi topic sessions, and resuming history
- Topic-backed sessions: each task lives in its own Feishu/Lark topic, so history,
  permissions, and follow-up messages stay scoped to that task
- Group chat mode: the group workbench only reacts to `@bot` messages, while TLive topic
  replies continue without repeated mentions
- Real-time progress cards with thinking, tool calls, summaries, and final output
- Claude Code permission approval, including session-level allow rules
- AskUserQuestion and deferred tool interactions for providers that support them
- Session scanning and resume from `~/.claude/projects/`, `~/.codex/sessions`, and Pi sessions under `~/.pi/agent/sessions`
- File and image forwarding to providers that support attachments
- Server/client execution model for managing local and remote worker nodes, including
  remote client self-upgrade
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

Run the one-time setup and start TLive:

```bash
tlive setup
tlive start
```

Then send `/tlive` in Feishu/Lark to open the workbench. In a group chat, mention the
bot, for example `@your-bot /tlive`.

`tlive start` starts the server control plane and a local worker client. Use
`tlive server --standalone` only when this machine should accept remote workers but not run a
local Claude/Codex/Pi worker.

Providers that support MCP injection connect to the TLive HTTP MCP endpoint for agent-side
callbacks. The MCP endpoint exposes tools such as `tlive_send_file`, `tlive_send_image`, and
`tlive_status`.

## Architecture

```text
┌─────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ Feishu/Lark │────▶│  tlive server    │◀────│ worker clients   │
│ chat/topics │     │ control plane    │     │ Claude/Codex/Pi  │
└─────────────┘     └──────────────────┘     └──────────────────┘
```

The server connects to Feishu through the Feishu/Lark SDK long connection. Agent execution runs in
worker clients, including the local client that `tlive start` launches by default. Claude Code is
integrated through `@anthropic-ai/claude-agent-sdk`; Codex is integrated through
`@openai/codex-sdk`; Pi is integrated through `@earendil-works/pi-coding-agent`.

## IM Commands

The main chat is a command-only workbench. Use `/tlive` or `/home` to open it, then start
Claude/Codex/Pi sessions from the client blocks. Each new session opens as its own
Feishu/Lark topic.

In group chats, the main workbench only handles messages that mention the bot, such as
`@your-bot /home`. Once a TLive topic has been created, replies in that topic are routed to
the bound agent session and do not need repeated `@bot` mentions.

Send normal task messages inside an agent topic to start or continue work:

```text
Fix the login bug in auth.ts
```

Normal text sent in the main chat will not start an agent session. If more than one execution
client is connected, use `/use <client-id>` in the workbench to choose the default client. When
there is exactly one client, TLive selects it automatically.

Public TLive commands are intentionally small so agent slash commands such as `/model` can
pass through to Claude Code, Codex, or Pi inside topics.

| Command | Description |
|---------|-------------|
| `/tlive` | Open the TLive workbench |
| `/home` | Alias for the workbench |
| `/use <client-id>` | Set the default execution client for the workbench |
| `/stop` | Interrupt the current execution inside an agent topic |

Other TLive operations are exposed in the workbench as buttons or command input, including
new Claude/Codex/Pi sessions, session history, directory browsing, permission mode,
diagnostics, restart, and upgrade.

## Settings

Choose the default provider:

```env
# ~/.tlive/client.env
TL_PROVIDER=claude
# or
TL_PROVIDER=codex

# or
TL_PROVIDER=pi
```

The workbench shows new-session buttons for providers reported by worker clients. Claude and Codex
still depend on their local CLIs; Pi is provided by the bundled Pi SDK and uses Pi's own auth/model
configuration.

Role-specific config files are used by default:

- `~/.tlive/server.env`: Feishu/Lark bridge and control-plane values
- `~/.tlive/client.env`: execution client values such as provider, default directory, and node note
- `~/.tlive/config.env`: legacy file, migrated into role files when needed

### Remote Workers

One machine can run the Feishu bot and scheduler while worker machines connect over WebSocket and
run local Claude/Codex/Pi sessions. `tlive server` already starts a local worker client. Start
additional workers with `tlive client` on the same host or on another machine.

Server machine:

```env
TL_REMOTE_TOKEN=change-this-token
```

```bash
tlive server
# or, for a pure control-plane server:
tlive server --standalone
```

Worker machine:

```bash
tlive client --server ws://your-server:8787/tlive --token change-this-token --workspace /path/to/project
```

For worker clients, `TL_DEFAULT_WORKDIR` is the default directory for new sessions.
`TL_REMOTE_WORKSPACES` is only a list of quick directories shown in the workbench; it does
not restrict `/cd`.

See [Server / Client Architecture](docs/architecture.md) for the control-plane and execution-plane
state ownership model.

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

Pi runtime options:

```env
TL_PI_AGENT_DIR=
TL_PI_SESSION_DIR=
TL_PI_PROVIDER=
TL_PI_MODEL=
TL_PI_THINKING=
TL_PI_NO_SESSION=false
TL_PI_OFFLINE=false
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

## Upgrade

Upgrade to the latest stable release:

```bash
tlive upgrade
```

Remote clients that advertise upgrade support can also be upgraded from the workbench when
their version is behind the server.

Upgrade to a specific release, including beta/prerelease versions when available:

```bash
tlive upgrade 0.14.0
tlive upgrade 0.14.0-beta.1
```

## Documentation

- [Getting Started](docs/getting-started.md)
- [Feishu Setup](docs/setup-feishu.md)
- [Configuration](docs/configuration.md)
- [Server / Client Architecture](docs/architecture.md)
- [Troubleshooting](docs/troubleshooting.md)

## License

MIT
