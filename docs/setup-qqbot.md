# QQ Bot Setup Guide

[Back to Getting Started](getting-started.md)

This guide walks you through creating and configuring a QQ Bot to connect with tlive.

## Prerequisites

- A QQ account
- About 5 minutes

## Step 1: Create a Bot Application

1. Open the QQ Bot management page:
   https://q.qq.com/qqbot/openclaw/
2. Log in with your QQ account
3. Click **Create Bot**
4. Fill in the bot information:
   - **Bot Name:** e.g., "tlive" or "Terminal Assistant"
   - **Description:** A brief description
5. Click **Confirm**

> **Tip:** Using https://q.qq.com/qqbot/openclaw/ allows quick bot creation without complex configuration.

## Step 2: Get Credentials

1. After creating the bot, go to the bot details page
2. Find in **Development Settings** or **Basic Info**:
   - **App ID** — A number, e.g., `1903453841`
   - **Client Secret** — An alphanumeric string
3. Copy these values and save them securely

> **Tip:** Keep your Client Secret secure. Anyone with App ID and Client Secret can control your bot.

## Step 3: Configure tlive

You have three options:

**Option A — Interactive Setup:**
```bash
tlive setup
```
Select QQ Bot and paste your App ID and Client Secret.

**Option B — AI-Guided Setup (Recommended):**
```
/tlive setup
```
Run in Claude Code for a guided configuration experience.

**Option C — Manual Configuration:**

Edit `~/.tlive/config.env`:
```env
TL_ENABLED_CHANNELS=qqbot
TL_QQ_APP_ID=your_app_id
TL_QQ_CLIENT_SECRET=your_client_secret
TL_QQ_ALLOWED_USERS=openid1,openid2
```

**Configuration Options:**

| Option | Description | Required |
|--------|-------------|----------|
| `TL_QQ_APP_ID` | QQ Bot App ID | Yes |
| `TL_QQ_CLIENT_SECRET` | QQ Bot Client Secret | Yes |
| `TL_QQ_ALLOWED_USERS` | Allowed user openids (comma-separated) | No, empty = all users |
| `TL_QQ_PROXY` | Proxy URL (e.g., `http://127.0.0.1:7890`) | No |

## Step 4: Configure Claude Code

tlive needs to know how to connect to Claude Code. Two options:

**Option 1 — Use Claude Code Settings File (Recommended)**

If you've already configured Claude Code in your project, tlive will automatically read the settings. Create `.claude/settings.local.json` in your project root:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "your_api_key",
    "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
    "ANTHROPIC_MODEL": "claude-sonnet-4-6"
  }
}
```

Then specify the settings sources in `~/.tlive/config.env`:

```env
TL_CLAUDE_SETTINGS=user,project,local
```

**Settings Sources:**

| Source | Path | Purpose |
|--------|------|---------|
| `user` | `~/.claude/settings.json` | Global auth and model config |
| `project` | `.claude/settings.json` + `CLAUDE.md` | Project rules, MCP, skills |
| `local` | `.claude/settings.local.json` | Developer local overrides |

**Option 2 — Set Directly in tlive Config**

Edit `~/.tlive/config.env`:

```env
ANTHROPIC_API_KEY=your_api_key
```

> **Note:** If using a custom API endpoint (e.g., Alibaba Cloud), configure `ANTHROPIC_BASE_URL` in the settings file.

## Step 5: Verify

1. Start the bridge:
   ```bash
   tlive start
   ```
   Or run `/tlive` in Claude Code.

2. Find your bot in QQ:
   - Send a direct message to the bot
   - Or @mention the bot in a group

3. Send a message (e.g., "hello")
4. If you receive a reply, configuration is successful!

## Supported Message Types

QQ Bot supports the following scenarios:

| Type | Description |
|------|-------------|
| C2C Direct Message | Direct conversation with bot |
| Group @mention | @mention the bot in a group |
| Guild Channel | Messages in QQ guild channels |
| Guild DM | Direct messages within QQ guilds |

## Permission Approval

When Claude needs to perform sensitive operations, QQ Bot sends a message with buttons:

```
🔐 Permission Required

**Tool:** `Bash`
```
rm -rf /tmp/test
```

⏱ Expires in 5 minutes

[✅ Yes]  [❌ No]
```

Click buttons or reply `allow` / `deny` to approve.

## Troubleshooting

**"invalid appid or secret" error**
- Check if App ID and Client Secret are copied correctly
- Ensure no extra spaces or newlines

**Not receiving messages**
- Confirm `TL_ENABLED_CHANNELS` includes `qqbot`
- Check tlive logs for connection errors
- Ensure the bot is online

**Bot not responding**
- Check Claude Code settings configuration
- Check tlive logs for API errors

**How to get user openid**
- When a user sends a message, tlive logs show the openid
- Add openid to `TL_QQ_ALLOWED_USERS` to authorize

## Proxy Configuration

If you need to access QQ Bot API through a proxy:

```env
# Global proxy (affects all platforms)
TL_PROXY=http://127.0.0.1:7890

# QQ Bot only proxy
TL_QQ_PROXY=socks5://127.0.0.1:1080
```

> **Note:** WebSocket connections may require system-level proxy (e.g., TUN mode) to work properly.