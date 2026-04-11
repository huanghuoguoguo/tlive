# 配置选项

配置文件位置：`~/.tlive/config.env`

## 基本配置

```env
# 服务端口
TL_PORT=8080

# 访问令牌（自动生成）
TL_TOKEN=auto-generated

# 启用的 IM 平台
TL_ENABLED_CHANNELS=telegram,feishu
```

## Telegram

```env
TL_TG_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrSTUvwxYZ
TL_TG_CHAT_ID=123456789

# 群组中需要 @ 机器人才能触发
TL_TG_REQUIRE_MENTION=true

# 禁用链接预览（消息更简洁）
TL_TG_DISABLE_LINK_PREVIEW=true

# 允许的用户白名单（用户 ID，逗号分隔）
TL_TG_ALLOWED_USERS=123456789,987654321
```

详见 [Telegram 配置指南](setup-telegram-cn.md)

## 飞书

```env
TL_FS_APP_ID=cli_xxx
TL_FS_APP_SECRET=xxx

# 允许的用户（open_id 或 user_id，逗号分隔）
TL_FS_ALLOWED_USERS=ou_xxx,xxx
```

详见 [飞书配置指南](setup-feishu-cn.md)

## Claude 设置

```env
# 新 chat 默认加载的 Claude 设置来源
# user    = ~/.claude/settings.json
# project = .claude/settings.json + CLAUDE.md + MCP + skills
# local   = .claude/settings.local.json
TL_CLAUDE_SETTINGS=user,project,local

# 默认工作目录
TL_DEFAULT_WORKDIR=/home/user/projects
```

可通过 `/settings user|full|isolated` 仅覆盖当前 chat 的 Claude 设置：

- `user`：只加载全局认证和模型配置
- `full`：加载 user + project + local
- `isolated`：当前 chat 不加载外部 settings

## 代理

```env
# HTTP 代理（适用于无法直连 Telegram 的地区）
TL_PROXY=http://127.0.0.1:7890
```

## 安全

```bash
# 设置配置文件权限
chmod 600 ~/.tlive/config.env
```

配置文件中的敏感信息（API Key、Token）在发送到 IM 前会自动脱敏。
