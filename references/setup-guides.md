# Platform Setup Guides

Detailed step-by-step guides for each IM platform. Referenced by the `setup` subcommand — only show the relevant section when the user asks for help.

---

## Telegram

### Bot Token

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` to create a new bot
3. Follow the prompts: choose a display name and a username (must end in `bot`)
4. BotFather will reply with a token like `7823456789:AAF-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
5. Copy the full token

**Recommended bot settings** (send to @BotFather):
- `/setprivacy` → choose your bot → `Disable` (for group messages)
- `/setcommands` → set: `new - Start new session`, `verbose - Set detail level`, `hooks - Toggle hook approval`

### Chat ID

1. Start a chat with your bot (search for the bot's username and click **Start**)
2. Send any message to the bot (e.g. "hello")
3. Open: `https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates`
4. In the JSON response, find `"chat":{"id":123456789,...}` — that number is your Chat ID
5. For group chats, the Chat ID is negative (e.g. `-1001234567890`)

### Allowed User IDs (optional)

1. Search for `@userinfobot` on Telegram and start a chat
2. It will reply with your User ID (e.g. `123456789`)

Enter comma-separated IDs to restrict access. Leave empty to allow anyone who can message the bot.

**Important:** At least one of Chat ID or Allowed User IDs should be set for security.

---

## Discord

### Bot Token

1. Go to https://discord.com/developers/applications
2. Click **New Application**, name it
3. Go to **Bot** tab → **Reset Token** → copy the token
4. Under **Privileged Gateway Intents**, enable **Message Content Intent**
5. Go to **OAuth2** → **URL Generator**: check `bot` scope, and permissions: Send Messages, Read Message History, Manage Messages
6. Copy the generated URL and open it to invite the bot to your server

### Allowed User IDs

1. In Discord, enable Developer Mode: User Settings → Advanced → Developer Mode
2. Right-click on a user → **Copy User ID**

### Allowed Channel IDs (optional)

1. Right-click on a channel → **Copy Channel ID**

**Important:** At least one of Allowed User IDs or Allowed Channel IDs should be set (default-deny).

---

## Feishu / Lark

### App ID & App Secret

1. Go to https://open.feishu.cn/app (or https://open.larksuite.com/app for Lark)
2. Click **Create Custom App**
3. Go to **Credentials & Basic Info** to find App ID and App Secret

### Required Permissions

In **Permissions & Scopes**, click **Batch import** and paste:

```json
{
  "scopes": {
    "tenant": [
      "cardkit:card:read",
      "cardkit:card:write",
      "im:chat:readonly",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ]
  }
}
```

### Event Subscriptions

After starting the bridge, configure events:
1. Go to **Events & Callbacks**
2. Add events:
   - `im.message.receive_v1` — receive messages
   - `card.action.trigger` — card button interactions (permission approval)
3. Set callback mode: **Long Connection (WebSocket)**
4. Publish the app version and get admin approval

### Allowed User IDs (optional)

Feishu user IDs can be found in the admin console or via the Feishu API.
