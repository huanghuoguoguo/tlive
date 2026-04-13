# Getting Started with tlive

This guide takes you from zero to a working tlive setup. By the end, you'll be able to monitor terminal sessions from your phone, chat with Claude Code via IM, and approve permissions remotely.

## Prerequisites

- **Node.js 20+** and npm
- One of: **Telegram** or **Feishu** account (for IM Bridge and Hook Approval)
- **Claude Code** installed (required for IM Bridge and Hook Approval features)

## Install

Linux / macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.sh | bash
```

Windows PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "$tmp = Join-Path $env:TEMP 'tlive-install.ps1'; Invoke-WebRequest 'https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.ps1' -UseBasicParsing -OutFile $tmp; & $tmp"
```

Verify the installation:

```bash
tlive --help
```

**What happens during install:** this fork is not published to npm. The installer above downloads the current release from GitHub. If the download fails, re-run the platform-specific install command above, or install from source using the repository README.

## Choose Your IM Platform

You can enable one or more platforms simultaneously. Here's a quick comparison to help you decide:

| Platform | Best for | Setup time |
|----------|----------|------------|
| **Telegram** | Individual developers. Create a bot with @BotFather in 2 minutes. | ~2 min |
| **Feishu** | Chinese teams on Feishu/Lark. More involved setup (needs admin approval). | ~15 min |

Detailed platform guides:

- [Telegram Setup](setup-telegram.md)
- [Feishu Setup](setup-feishu.md)

## Configure

Pick whichever method suits you best.

### Option A: AI-Guided Setup (Recommended)

Inside Claude Code, run:

```
/tlive setup
```

The AI walks you through each step interactively — it will explain what each config value means, help you create bot tokens, and verify everything works.

### Option B: CLI Wizard

```bash
tlive setup
```

Interactive prompts guide you through platform selection and credentials. Good if you already have your bot tokens ready.

### Option C: Manual Configuration

Edit `~/.tlive/config.env` directly. Use [config.env.example](../config.env.example) as a reference for all available options.

Key settings:

```env
# Which platforms to enable (comma-separated)
TL_ENABLED_CHANNELS=telegram

# Telegram example
TL_TG_BOT_TOKEN=7823456789:AAF-xxxxx
TL_TG_CHAT_ID=123456789

# Web terminal port and access token
TL_PORT=8080
TL_TOKEN=your-secret-token
```

Make sure to secure the config file:

```bash
chmod 600 ~/.tlive/config.env
```

## Install Claude Code Integration

```bash
tlive install skills
```

This registers:

- The `/tlive` skill for Claude Code
- Reference docs under `~/.tlive/docs/`

## Try It Out

### Feature 1: IM Bridge

In Claude Code, start the bridge:

```
/tlive
```

Now open your IM app on your phone and send a message to the bot. Claude Code will receive it, work on the task, and stream the response back to your phone — including tool usage and progress updates.

Other useful commands: `/perm on|off` (permissions), `/stop` (interrupt), `/sessions` (recent sessions).

## Troubleshooting

**Run automated diagnostics:**

```bash
tlive doctor
```

**Check logs:**

```bash
tlive logs 50
```

**Common issues:**

- **"Binary not found"** — Installation incomplete. Re-run the platform-specific install command from the Install section above.
- **"Bridge not starting"** — Check that `~/.tlive/config.env` exists and has valid credentials. Run `tlive doctor` for details.
- **"No IM messages"** — Verify your bot token is correct and the bot has been added to the right chat. See the platform-specific troubleshooting in the setup guides above.

## Next Steps

- **Need less noise?** Use `/sessions` and `/session <n>` to resume prior work instead of starting over
- **Install the Claude Code command:** run `tlive install skills` if you have not done it yet
- Read the full [README](../README.md) for all commands and architecture details
