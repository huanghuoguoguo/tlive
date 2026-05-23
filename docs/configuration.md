# Configuration Options

Config file location: `~/.tlive/config.env`

## Basic Settings

```env
TL_PORT=8080
TL_TOKEN=auto-generated
TL_DEFAULT_WORKDIR=/home/user/projects
TL_DEFAULT_MODEL=

# Completed/failed task card buttons.
# Default is only the workbench button. Add more if needed.
# Supported: home,new,help,perm,none
TL_DONE_BUTTONS=home
```

## Feishu / Lark

```env
TL_FS_APP_ID=cli_xxx
TL_FS_APP_SECRET=xxx
TL_FS_VERIFICATION_TOKEN=
TL_FS_ENCRYPT_KEY=
TL_FS_WEBHOOK_PORT=9100
TL_FS_AUTO_PIN_TOPIC=true

# Optional user whitelist: open_id or user_id, comma-separated
TL_FS_ALLOWED_USERS=ou_xxx,xxx
```

See [Feishu Setup Guide](setup-feishu.md).

## Agent Settings

```env
# Settings sources loaded by default for new chats
# user    = ~/.claude/settings.json
# project = .claude/settings.json + CLAUDE.md + project MCP config
# local   = .claude/settings.local.json
TL_AGENT_SETTINGS=user,project,local
```

Existing `TL_CLAUDE_SETTINGS` configs are still accepted as an alias.

Use `/settings user|full|isolated` to override Claude settings for the current chat only:

- `user`: auth/model config only
- `full`: user + project + local settings
- `isolated`: ignore external settings for this chat

## Automation

```env
TL_WEBHOOK_ENABLED=false
TL_WEBHOOK_TOKEN=
TL_WEBHOOK_PORT=8081
TL_WEBHOOK_PATH=/webhook
TL_WEBHOOK_SESSION_STRATEGY=reject
```

## Security

```bash
chmod 600 ~/.tlive/config.env
```

Sensitive info in config is automatically redacted before sending to IM.
