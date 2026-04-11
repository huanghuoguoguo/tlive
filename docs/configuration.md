# Configuration Options

Config file location: `~/.tlive/config.env`

## Basic Settings

```env
# Service port
TL_PORT=8080

# Access token (auto-generated)
TL_TOKEN=auto-generated

# Enabled IM platforms
TL_ENABLED_CHANNELS=telegram,feishu
```

## Telegram

```env
TL_TG_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrSTUvwxYZ
TL_TG_CHAT_ID=123456789

# Require @mention in groups
TL_TG_REQUIRE_MENTION=true

# Disable link preview
TL_TG_DISABLE_LINK_PREVIEW=true

# Allowed users whitelist
TL_TG_ALLOWED_USERS=123456789,987654321
```

See [Telegram Setup Guide](setup-telegram.md)

## Feishu

```env
TL_FS_APP_ID=cli_xxx
TL_FS_APP_SECRET=xxx

# Allowed users (open_id or user_id)
TL_FS_ALLOWED_USERS=ou_xxx,xxx
```

See [Feishu Setup Guide](setup-feishu.md)

## Claude Settings

```env
# Settings sources loaded by default for new chats
# user    = ~/.claude/settings.json
# project = .claude/settings.json + CLAUDE.md + MCP + skills
# local   = .claude/settings.local.json
TL_CLAUDE_SETTINGS=user,project,local

# Default working directory
TL_DEFAULT_WORKDIR=/home/user/projects
```

Use `/settings user|full|isolated` to override Claude settings for the current chat only:

- `user`: auth/model config only
- `full`: user + project + local settings
- `isolated`: ignore external settings for this chat

## Proxy

```env
# HTTP proxy (for regions where Telegram is blocked)
TL_PROXY=http://127.0.0.1:7890
```

## Security

```bash
# Set config file permissions
chmod 600 ~/.tlive/config.env
```

Sensitive info (API keys, tokens) in config is automatically redacted before sending to IM.
