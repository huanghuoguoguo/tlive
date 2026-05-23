# 配置选项

配置文件位置：`~/.tlive/config.env`

## 基本配置

```env
TL_TOKEN=auto-generated
TL_DEFAULT_WORKDIR=/home/user/projects
TL_DEFAULT_MODEL=

# 任务完成/失败卡片底部按钮。
# 默认只显示工作台按钮。需要更多按钮时可追加。
# 支持：home,new,help,perm,none
TL_DONE_BUTTONS=home
```

## 飞书 / Lark

```env
TL_FS_APP_ID=cli_xxx
TL_FS_APP_SECRET=xxx
TL_FS_VERIFICATION_TOKEN=
TL_FS_ENCRYPT_KEY=
TL_FS_AUTO_PIN_TOPIC=true

# 可选用户白名单：open_id 或 user_id，逗号分隔
TL_FS_ALLOWED_USERS=ou_xxx,xxx
```

详见 [飞书配置指南](setup-feishu-cn.md)。

## Agent 设置

```env
# 新 chat 默认加载的 Agent 设置来源
# user    = ~/.claude/settings.json
# project = .claude/settings.json + CLAUDE.md + project MCP config
# local   = .claude/settings.local.json
TL_AGENT_SETTINGS=user,project,local
```

可通过 `/settings user|full|isolated` 仅覆盖当前 chat 的 Claude 设置：

- `user`：只加载全局认证和模型配置
- `full`：加载 user + project + local
- `isolated`：当前 chat 不加载外部 settings

## MCP

```env
TL_MCP_ENABLED=true
TL_MCP_PORT=8081
TL_MCP_PATH=/mcp
TL_MCP_TOKEN=
TL_MCP_MAX_FILE_MB=20
```

## 执行 Client

server 始终监听执行 client。`tlive start` 和 `tlive server` 还会默认启动一个本地
client，除非传入 `--standalone`。

```env
TL_REMOTE_SERVER_PORT=8787
TL_REMOTE_SERVER_PATH=/tlive
TL_REMOTE_TOKEN=

TL_REMOTE_SERVER_URL=ws://your-server:8787/tlive
TL_REMOTE_CLIENT_ID=
TL_REMOTE_CLIENT_NAME=
TL_REMOTE_WORKSPACES=/path/to/project
```

执行 client 会自动检测本机可用 provider。

## 安全

```bash
chmod 600 ~/.tlive/config.env
```

配置文件中的敏感信息在发送到 IM 前会自动脱敏。
