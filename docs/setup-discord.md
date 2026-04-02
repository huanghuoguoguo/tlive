# Discord Setup Guide

[Back to Getting Started](getting-started.md)

This guide walks you through creating a Discord bot and connecting it to tlive so you can monitor and interact with your terminal sessions from Discord.

## What You'll Need

- A Discord account
- A Discord server where you have admin permissions (or create a new one -- it's free)
- About 5 minutes

## Step 1: Create a Discord Application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** in the top-right corner
3. Give it a name (e.g., "tlive") and click **Create**

<!-- ![New Application button](images/discord-new-app.png) -->

You'll be taken to your application's settings page.

## Step 2: Create a Bot

1. Click the **Bot** tab in the left sidebar
2. Click **Reset Token**, then confirm
3. **Copy the token immediately** -- you won't be able to see it again (if you lose it, you can reset it)

Next, scroll down to **Privileged Gateway Intents** and enable:

- **Message Content Intent** -- this is required for the bot to read message content

<!-- ![Message Content Intent toggle](images/discord-intents.png) -->

> **Important:** Without Message Content Intent enabled, the bot will connect but won't be able to read any messages. This is the most common setup issue.

## Step 3: Set Permissions & Invite the Bot

1. Click the **OAuth2** tab in the left sidebar, then **URL Generator**
2. Under **Scopes**, check `bot`
3. Under **Bot Permissions**, check:
   - **Send Messages**
   - **Read Message History**
   - **Manage Messages**
   - **Add Reactions**
   - **Create Public Threads**
4. Copy the **Generated URL** at the bottom of the page

<!-- ![OAuth2 URL Generator](images/discord-oauth2.png) -->

Open the URL in your browser. You'll be asked to select a server -- pick the one where you want the bot, then click **Authorize**.

The bot should now appear in your server's member list (it will show as offline until you start tlive).

## Step 4: Get Your User ID and Channel ID

Discord uses numeric IDs internally. You'll need your User ID (required) and optionally a Channel ID.

### Enable Developer Mode

1. Open Discord and go to **User Settings** (gear icon near your username)
2. Navigate to **Advanced**
3. Toggle on **Developer Mode**

### Copy Your User ID

- Right-click your own username (in a chat or the member list)
- Click **Copy User ID**

### Copy a Channel ID (optional)

- Right-click the channel name in the sidebar
- Click **Copy Channel ID**

Setting an allowed channel restricts the bot to only respond in that specific channel.

> **Security note:** At least one of Allowed User IDs or Allowed Channel IDs should be set. Without these, anyone in the server could interact with the bot.

## Step 5: Configure tlive

You have three options:

### Option A: Interactive Setup (easiest)

```bash
tlive setup
```

Select "Discord" when prompted, then paste your token and IDs.

### Option B: Claude Code Slash Command (recommended for Claude Code users)

Run `/tlive setup` inside Claude Code and follow the prompts.

### Option C: Manual Configuration

Edit `~/.tlive/config.env`:

```env
TL_ENABLED_CHANNELS=discord
TL_DC_BOT_TOKEN=your-bot-token-here
TL_DC_ALLOWED_USERS=your-user-id
TL_DC_ALLOWED_CHANNELS=channel-id  # optional
```

For multiple users or channels, separate IDs with commas:

```env
TL_DC_ALLOWED_USERS=111111111,222222222
TL_DC_ALLOWED_CHANNELS=333333333,444444444
```

## Step 6: Verify It Works

1. Start the bridge:
   ```bash
   tlive start
   ```
   Or use `/tlive` in Claude Code.

2. The bot should come online in your Discord server
3. Send a message in the channel where the bot is present
4. You should see a response confirming the connection

## Features

### Auto-Threading

When you send a message, the bot automatically creates a **Thread** from its first reply. All follow-up messages in the same session go into that thread, keeping the main channel clean. Use `/new` to start a fresh session (and a new thread).

### Reactions

The bot uses reactions to show processing status:
- 🤔 Processing your message
- 👍 Complete
- ❌ Error

### Text-Based Approval

In addition to clicking buttons, you can reply `allow` or `deny` to permission requests when buttons have expired.

### Embed-Style Output

Commands like `/status`, `/help`, `/sessions` render as rich Discord embeds for a cleaner look.

### Proxy

If Discord is blocked in your region, set a global proxy:
```env
TL_PROXY=http://127.0.0.1:7890
```

Or a Discord-specific proxy (overrides the global one):
```env
TL_DC_PROXY=http://127.0.0.1:7890
```

Supported protocols: `http://`, `https://`. Note: SOCKS proxy is not supported for Discord due to a discord.js library limitation. For full proxy support (including WebSocket), use a system-level proxy such as Clash TUN mode.

## Troubleshooting

**Bot shows as offline**
- Double-check your bot token is correct
- Make sure **Message Content Intent** is enabled (Step 2)
- Check that tlive is actually running (`tlive status`)

**"Missing Access" or "Missing Permissions" errors**
- The bot needs Send Messages, Read Message History, Manage Messages, Add Reactions, and Create Public Threads permissions
- If the channel has custom permission overrides, make sure the bot role is allowed
- The bot checks permissions at startup and logs warnings for any missing ones

**Bot is online but doesn't respond to messages**
- This almost always means **Message Content Intent** is not enabled -- go back to the Bot tab in the Developer Portal and turn it on
- Make sure your User ID is in the allowed users list
- If you set an allowed channel, make sure you're messaging in that channel

**"Invalid token" error on startup**
- Tokens look like `MTIzNDU2Nzg5.Gh7x2A.xxxxx...` -- make sure you copied the full token
- If you regenerated the token, update it in your config
