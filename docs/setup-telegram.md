# Telegram Setup Guide

[Back to Getting Started](getting-started.md)

This guide walks you through creating a Telegram bot and connecting it to tlive so you can interact with your terminal sessions from Telegram.

## What You'll Need

- A Telegram account
- ~5 minutes

## Step 1: Create a Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Choose a **display name** (e.g. "My tlive Bot") and a **username** (must end in `bot`, e.g. `my_tlive_bot`)
4. BotFather will reply with a token like `7823456789:AAF-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
5. Copy the **full token** — you'll need it in Step 4

<!-- TODO: screenshot of BotFather conversation -->

> **Tip:** Keep your token secret. Anyone with the token can control your bot.

## Step 2: Get Your Chat ID

Your Chat ID tells tlive where to send messages.

1. Open a chat with your new bot (search for its username and tap **Start**)
2. Send any message (e.g. "hello")
3. Open this URL in your browser (replace `YOUR_TOKEN` with the token from Step 1):
   ```
   https://api.telegram.org/botYOUR_TOKEN/getUpdates
   ```
4. In the JSON response, look for `"chat":{"id":123456789,...}` — that number is your Chat ID
5. For **group chats**, the Chat ID is negative (e.g. `-1001234567890`)

<!-- TODO: screenshot of getUpdates JSON response -->

> **Important:** You must send a message to the bot *before* opening the URL, otherwise the response will be empty.

## Step 3 (Optional): Get User IDs

If you want to restrict who can use the bot, you'll need Telegram User IDs.

1. Search for **@userinfobot** on Telegram and start a chat
2. It will reply with your User ID (e.g. `123456789`)
3. Repeat for each person you want to allow — you'll enter them as comma-separated values

> **Security note:** Setting at least a Chat ID or Allowed User IDs is recommended. Without them, anyone who finds your bot can interact with it.

## Step 4: Configure tlive

You have three options:

**Option A — Interactive setup:**
```bash
tlive setup
```
Select Telegram when prompted, then paste your token and Chat ID.

**Option B — AI-guided setup (recommended):**
```
/tlive setup
```
Run this inside Claude Code for a guided experience.

**Option C — Manual configuration:**

Edit `~/.tlive/config.env`:
```env
TL_ENABLED_CHANNELS=telegram
TL_TG_BOT_TOKEN=your-token
TL_TG_CHAT_ID=your-chat-id
TL_TG_ALLOWED_USERS=user-id-1,user-id-2
```

## Step 5: Verify

1. Start the bridge:
   ```bash
   tlive start
   ```
   Or run `/tlive` in Claude Code.

2. Send a message to your bot in Telegram
3. You should see a response — if so, you're all set!

<!-- TODO: screenshot of successful interaction -->

## Recommended Bot Settings

Send each command to **@BotFather**:

| Command | Setting | Why |
|---------|---------|-----|
| `/setprivacy` | Select your bot → `Disable` | Lets the bot read messages in group chats |

> **Note:** The `/setcommands` step is no longer needed — tlive automatically registers commands (`/new`, `/status`, `/help`, etc.) to the Telegram menu on startup.

## Features & Configuration

### Group @Mention Filtering

In group chats, the bot only responds when **@mentioned** (default behavior). This prevents it from responding to every message in the group.

```env
TL_TG_REQUIRE_MENTION=true    # default: only respond to @bot
TL_TG_REQUIRE_MENTION=false   # respond to all messages in group
```

Replies to bot messages also work without `@mention`.

### Pairing Mode

If `TL_TG_ALLOWED_USERS` is not set, the bot enters **pairing mode**:

1. An unknown user sends a message → bot replies with a 6-digit pairing code
2. An admin (from any authorized channel) runs `/approve <code>`
3. The user is approved and can now interact with the bot

Use `/pairings` to list pending pairing requests. Codes expire after 1 hour.

### Forum Topics

The bot supports Telegram forum-style groups with topics. Messages are routed to the correct topic automatically.

### Webhook Mode (Optional)

By default, the bot uses long-polling. For production environments, you can switch to webhooks:

```env
TL_TG_WEBHOOK_URL=https://your-domain.com/telegram-webhook
TL_TG_WEBHOOK_SECRET=your-random-secret
TL_TG_WEBHOOK_PORT=8443
```

### Link Preview

Link previews are disabled by default to keep messages clean. To enable:
```env
TL_TG_DISABLE_LINK_PREVIEW=false
```

### Proxy

If `api.telegram.org` is blocked in your region, set a global proxy (applies to both Telegram and Discord):
```env
TL_PROXY=http://127.0.0.1:7890
```

Or set a Telegram-specific proxy (overrides the global one):
```env
TL_TG_PROXY=socks5://127.0.0.1:1080
```

Supported protocols: `http://`, `https://`, `socks4://`, `socks5://`.

## Troubleshooting

**Bot not responding**
- Double-check that the token is correct (no extra spaces or missing characters)
- Run `tlive doctor` to check your configuration

**Wrong Chat ID**
- Make sure you sent a message to the bot *first*, then refresh the `getUpdates` URL
- If using a group, make sure the bot has been added to the group

**"Unauthorized" error**
- Your token may have been regenerated in BotFather — go back and copy the latest one
- Each time you reset the token, the old one stops working immediately

**Bot doesn't respond in groups**
- Check that Privacy Mode is disabled: BotFather → `/setprivacy` → Disable
- After changing privacy, remove and re-add the bot to the group
- If `TL_TG_REQUIRE_MENTION=true` (default), you need to @mention the bot

**Bot shows warning about permissions on startup**
- This is informational. The bot probes its capabilities at startup and warns about potential issues
- Common warning: "Group Privacy not disabled" — see above
