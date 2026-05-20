# Feishu / Lark Setup Guide

This guide is referenced by `/tlive setup`. Show only the specific step the user
needs unless they ask for the full guide.

## App ID and App Secret

1. Open the Feishu developer console: https://open.feishu.cn/app
2. For Lark tenants, use: https://open.larksuite.com/app
3. Create a custom app.
4. Open **Credentials & Basic Info**.
5. Copy **App ID** to `TL_FS_APP_ID`.
6. Copy **App Secret** to `TL_FS_APP_SECRET`.

## Required Permissions

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

## Event Subscriptions

TLive uses Feishu long connection mode, so users do not need a public callback
URL for ordinary message receive or card actions.

1. Open **Events & Callbacks**.
2. Enable **Long Connection** mode.
3. Add these events:
   - `im.message.receive_v1`
   - `card.action.trigger`
4. Publish the app version.
5. Complete admin approval.

## Allowed User IDs

`TL_FS_ALLOWED_USERS` is optional. If set, only listed Feishu user IDs can use
the bot.

Ways to find a user ID:
- Ask the user to send the bot a private message, then check `tlive logs`.
- Use the Feishu admin console.
- Use Feishu's contact/user API.

Use comma-separated IDs for multiple users.

## First Run Check

After writing `~/.tlive/config.env`:

1. Run `tlive start`.
2. Send the bot a private Feishu message.
3. Confirm normal replies, progress cards, and permission approval cards work.
4. If messages do not arrive, run `tlive doctor` and inspect `tlive logs 200`.
