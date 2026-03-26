# Feishu / Lark Setup Guide

[Back to Getting Started](getting-started.md)

This guide walks you through creating a Feishu (or Lark) custom app and connecting it to tlive. Feishu requires a few more steps than other platforms — you'll need to create an app, configure permissions, set up event subscriptions, and get admin approval. Don't worry, this guide covers every step in detail.

## What You'll Need

- A Feishu account (or Lark account for the international version)
- Admin access to create apps, or a workspace admin who can approve your app
- ~10 minutes

## Step 1: Create a Custom App

1. Go to the Feishu Open Platform developer console:
   - **Feishu (China):** https://open.feishu.cn/app
   - **Lark (International):** https://open.larksuite.com/app
2. Sign in with your Feishu/Lark account
3. Click **Create Custom App**
4. Fill in the details:
   - **App Name:** Something like "tlive" or "Terminal Bot"
   - **Description:** A short description, e.g. "Terminal session bridge for tlive"
5. Click **Create**

<!-- TODO: screenshot of "Create Custom App" button and form -->

> **Note:** If you don't see the "Create Custom App" button, your workspace admin may have restricted app creation. Ask your admin to either create the app for you or grant you developer permissions.

## Step 2: Get Your Credentials

1. After creating the app, you'll land on the app's overview page
2. Go to **Credentials & Basic Info** in the left sidebar
3. You'll see two values:
   - **App ID** — looks like `cli_xxxxxxxxxxxxxxxx`
   - **App Secret** — a longer alphanumeric string
4. Copy both values and save them somewhere safe — you'll need them in Step 6

<!-- TODO: screenshot of Credentials & Basic Info page with App ID and App Secret highlighted -->

> **Tip:** Keep your App Secret private. Anyone with the App ID and Secret can act as your bot.

## Step 3: Add Permissions

Your app needs permission to send and receive messages.

1. In the left sidebar, go to **Permissions & Scopes**
2. Click **Batch import**, then paste the following JSON to add all required permissions at once:

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

**Permission details:**

| Permission | Description | Necessity |
|---|---|---|
| `im:message` | Send and receive messages | Required |
| `im:message:send_as_bot` | Send messages as a bot | Required |
| `im:chat:readonly` | Read basic chat info | Required |
| `im:message:readonly` | Read message content | Required |
| `im:message.p2p_msg:readonly` | Read P2P messages | Required |
| `im:message.group_at_msg:readonly` | Read group @bot messages | Recommended |
| `cardkit:card:read` | Read card info | Recommended |
| `cardkit:card:write` | CardKit streaming cards | Recommended |
| `im:resource` | Upload images and files | Optional |

3. Confirm all permissions appear in the list

> **Tip:** Using batch import adds all permissions at once — no need to search for each one individually.

## Step 4: Configure Event Subscriptions

This step tells Feishu to notify tlive when someone messages the bot.

1. In the left sidebar, go to **Events & Callbacks**
2. Under **Event Subscriptions**, click **Add Event**
3. Add the following events:
   - `im.message.receive_v1` (receive messages)
   - `card.action.trigger` (card button interaction callback)
4. Now set the **callback mode**:
   - Select **Long Connection (WebSocket)**
   - Do **NOT** select HTTP callback — tlive uses WebSocket mode so you don't need to expose a public URL

<!-- TODO: screenshot of Events & Callbacks page showing Long Connection selected -->

> **Why WebSocket?** With Long Connection mode, tlive connects outward to Feishu's servers. This means you don't need a public IP, a domain name, or any firewall changes. It just works from anywhere.

## Step 5: Publish and Get Admin Approval

Feishu apps aren't active until they're published and approved by a workspace admin.

1. In the left sidebar, go to **App Release** (or **Version Management**)
2. Click **Create Version**
3. Fill in:
   - **Version Number:** e.g. `1.0.0`
   - **Update Notes:** e.g. "Initial release — terminal session bridge"
   - **Availability:** Choose which users/departments can use the app, or select "All employees"
4. Click **Save** and then **Submit for Review**
5. A workspace admin needs to approve the app:
   - The admin goes to the **Feishu Admin Console** (https://feishu.cn/admin or https://larksuite.com/admin)
   - Navigate to **App Review** or **Workspace Apps**
   - Find your app and click **Approve**

<!-- TODO: screenshot of Create Version page -->
<!-- TODO: screenshot of admin approval in Admin Console -->

> **If you are the admin:** You can approve it yourself in the Admin Console immediately after submitting.

> **If you're not the admin:** Let your admin know you've submitted the app. They'll see a notification in the Admin Console.

## Step 6: Configure tlive

You have three options:

**Option A — Interactive setup:**
```bash
tlive setup
```
Select Feishu when prompted, then paste your App ID and App Secret.

**Option B — AI-guided setup (recommended):**
```
/tlive setup
```
Run this inside Claude Code for a guided experience.

**Option C — Manual configuration:**

Edit `~/.tlive/config.env`:
```env
TL_ENABLED_CHANNELS=feishu
TL_FS_APP_ID=cli_xxxxxxxxxxxxxxxx
TL_FS_APP_SECRET=your-app-secret
TL_FS_ALLOWED_USERS=ou_xxxxxxxxxxxxxxxx
```

The `TL_FS_ALLOWED_USERS` field is optional. If set, only the listed user Open IDs can interact with the bot. Leave it empty to allow anyone in your workspace.

> **Finding a user's Open ID:** When someone messages your bot, tlive logs their Open ID. You can also find Open IDs through the Feishu Admin Console under user management, or via the [Feishu API](https://open.feishu.cn/document/server-docs/contact-v3/user/get).

## Step 7: Verify

1. Start the bridge:
   ```bash
   tlive start
   ```
   Or run `/tlive` in Claude Code.

2. Open Feishu and find your bot:
   - Search for the app name you chose in Step 1
   - Or go to your contact list — the bot should appear under **Bots** or **Apps**
3. Send the bot a direct message (e.g. "hello")
4. You should see a response in an interactive card — if so, you're all set!

<!-- TODO: screenshot of successful bot interaction in Feishu -->

> **Can't find the bot?** The app must be published and approved (Step 5) before it appears as a bot in Feishu. If you just submitted for approval, wait for the admin to approve it.

## Lark (International Version)

If you use Lark instead of Feishu, everything works the same. The only differences:

- Use https://open.larksuite.com/app for the developer console
- Use https://larksuite.com/admin for the admin console
- The UI may be in English by default

All environment variable names, permissions, and event names are identical.

## Troubleshooting

**"App not approved" / bot not visible**
- The app must be published (Step 5) and approved by a workspace admin before it becomes active
- Check the Admin Console for pending approvals

**No events received / bot doesn't respond**
- Make sure you selected **Long Connection (WebSocket)** in Step 4, not HTTP callback
- Verify that both `im.message.receive_v1` and `card.action.trigger` events are added
- Check that `TL_FS_APP_ID` and `TL_FS_APP_SECRET` are correct (no extra spaces)

**Permission denied errors**
- Confirm all permissions from the batch import in Step 3 appear in the permission list
- Permissions take effect after the app is published and approved — if you added permissions later, create a new version and get it re-approved

**"Invalid App ID" or "Invalid App Secret"**
- Double-check you copied the full values from Step 2
- Make sure you're using the credentials from the correct app (if you created multiple)
- Run `tlive doctor` to check your configuration

**Bot responds in Feishu but not in tlive**
- Make sure `TL_ENABLED_CHANNELS` includes `feishu`
- Check the tlive logs for connection errors
