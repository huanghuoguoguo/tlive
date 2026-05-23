# Configuration Options

Config file location: `~/.tlive/config.env`

## Basic Settings

```env
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

Use `/settings user|full|isolated` to override Claude settings for the current chat only:

- `user`: auth/model config only
- `full`: user + project + local settings
- `isolated`: ignore external settings for this chat

## MCP

```env
TL_MCP_ENABLED=true
TL_MCP_PORT=8081
TL_MCP_PATH=/mcp
TL_MCP_TOKEN=
TL_MCP_MAX_FILE_MB=20
```

## Execution Clients

The server always listens for execution clients. `tlive start` and `tlive server` also start a
local client unless `--standalone` is passed.

```env
TL_REMOTE_SERVER_PORT=8787
TL_REMOTE_SERVER_PATH=/tlive
TL_REMOTE_TOKEN=

TL_REMOTE_SERVER_URL=ws://your-server:8787/tlive
TL_REMOTE_CLIENT_ID=
TL_REMOTE_CLIENT_NAME=
TL_REMOTE_WORKSPACES=/path/to/project
```

Worker clients auto-detect available local providers.

## Security

```bash
chmod 600 ~/.tlive/config.env
```

Sensitive info in config is automatically redacted before sending to IM.
