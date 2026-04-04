# Configuration Options

Config file location: `~/.tlive/config.env`

## Basic Settings

```env
# Service port
TL_PORT=8080

# Access token (auto-generated)
TL_TOKEN=auto-generated

# Public URL (for tunneling)
TL_PUBLIC_URL=https://your-domain.com

# Enabled IM platforms
TL_ENABLED_CHANNELS=telegram,discord
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

## Discord

```env
TL_DC_BOT_TOKEN=your-bot-token

# Allowed channels
TL_DC_ALLOWED_CHANNELS=123456789,987654321

# Allowed users whitelist
TL_DC_ALLOWED_USERS=111222333
```

See [Discord Setup Guide](setup-discord.md)

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
# Settings scope (user=auth only, full=load CLAUDE.md/MCP/skills)
TL_CLAUDE_SETTINGS=user

# Default working directory
TL_DEFAULT_WORKDIR=/home/user/projects
```

## Proxy

```env
# HTTP proxy (for regions where Telegram/Discord is blocked)
TL_PROXY=http://127.0.0.1:7890
```

## Security

```bash
# Set config file permissions
chmod 600 ~/.tlive/config.env
```

Sensitive info (API keys, tokens) in config is automatically redacted before sending to IM.