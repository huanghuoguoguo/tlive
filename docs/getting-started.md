# Getting Started with tlive

This guide takes you from zero to a working Feishu/Lark bridge for Claude Code.

## Prerequisites

- Node.js 20+ and npm
- A Feishu or Lark workspace where you can create a custom app
- Claude Code installed and authenticated

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

## Configure Feishu

Follow the [Feishu Setup Guide](setup-feishu.md) to create the custom app, enable bot messaging, configure event subscriptions, and publish the app.

You need these values in `~/.tlive/config.env`:

```env
TL_TOKEN=your-secret-token
TL_FS_APP_ID=cli_xxx
TL_FS_APP_SECRET=xxx
TL_FS_VERIFICATION_TOKEN=
TL_FS_ENCRYPT_KEY=
TL_FS_ALLOWED_USERS=
```

Secure the config file:

```bash
chmod 600 ~/.tlive/config.env
```

## MCP Integration

TLive SDK sessions automatically load the bundled MCP server. Agents launched by TLive can call
back into TLive for file/image delivery and automation prompts while TLive keeps Feishu topic
routing and permissions on the bridge side.

## Start

Start the bridge:

```bash
tlive start
```

Then open Feishu/Lark and send the bot a task:

```text
Fix the login bug in auth.ts
```

Claude Code will execute locally and stream progress, tool usage, permission prompts, and the final answer back to Feishu.

## Useful Commands

- `/perm on|off`: toggle permission prompts
- `/stop`: interrupt current execution
- `/cd <path>`: switch workdir
- `/pwd`: show workdir

## Troubleshooting

```bash
tlive logs 50
```

Common issues:

- Bridge cannot start: check `TL_FS_APP_ID`, `TL_FS_APP_SECRET`, and `TL_TOKEN`.
- Bot receives messages but cards do not respond: verify Feishu card callback settings.
- No Feishu messages arrive: verify event subscriptions and app publish/admin approval.
