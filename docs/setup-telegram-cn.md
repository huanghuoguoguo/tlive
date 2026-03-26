# Telegram 配置指南

[返回入门指南](getting-started-cn.md)

本指南将带你一步步创建 Telegram 机器人，并将其连接到 tlive，从而在 Telegram 中与终端会话进行交互。

## 前置条件

- 一个 Telegram 账号
- 大约 5 分钟时间

## 第一步：创建机器人

1. 打开 Telegram，搜索 **@BotFather**
2. 发送 `/newbot`
3. 设置**显示名称**（如「我的 tlive 机器人」）和**用户名**（必须以 `bot` 结尾，如 `my_tlive_bot`）
4. BotFather 会回复一个 Token，类似 `7823456789:AAF-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
5. 复制**完整的 Token**，后续步骤会用到

<!-- TODO: screenshot of BotFather conversation -->

> **提示：** Token 相当于机器人的密码，请妥善保管，不要泄露给他人。

## 第二步：获取 Chat ID

Chat ID 用于告诉 tlive 往哪里发消息。

1. 搜索你刚创建的机器人用户名，点击 **Start** 开始对话
2. 随便发一条消息（比如「你好」）
3. 在浏览器中打开以下地址（把 `YOUR_TOKEN` 替换成第一步拿到的 Token）：
   ```
   https://api.telegram.org/botYOUR_TOKEN/getUpdates
   ```
4. 在返回的 JSON 中找到 `"chat":{"id":123456789,...}`，这串数字就是你的 Chat ID
5. 如果是**群聊**，Chat ID 会是负数（如 `-1001234567890`）

<!-- TODO: screenshot of getUpdates JSON response -->

> **注意：** 必须先给机器人发一条消息，再打开上面的链接，否则返回结果为空。

## 第三步（可选）：获取用户 ID

如果你想限制谁能使用这个机器人，需要获取对应的 Telegram 用户 ID。

1. 在 Telegram 中搜索 **@userinfobot**，开始对话
2. 它会回复你的用户 ID（如 `123456789`）
3. 需要允许多个用户的话，对每个人重复操作，最后用英文逗号分隔填入

> **安全建议：** 建议至少设置 Chat ID 或用户白名单中的一项。如果都不设置，任何人找到你的机器人都能与之交互。

## 第四步：配置 tlive

有三种方式可供选择：

**方式 A — 交互式配置：**
```bash
tlive setup
```
按提示选择 Telegram，然后粘贴 Token 和 Chat ID。

**方式 B — AI 引导配置（推荐）：**
```
/tlive setup
```
在 Claude Code 中运行此命令，获得 AI 引导的配置体验。

**方式 C — 手动编辑配置文件：**

编辑 `~/.tlive/config.env`：
```env
TL_ENABLED_CHANNELS=telegram
TL_TG_BOT_TOKEN=your-token
TL_TG_CHAT_ID=your-chat-id
TL_TG_ALLOWED_USERS=user-id-1,user-id-2
```

## 第五步：验证

1. 启动 bridge：
   ```bash
   tlive start
   ```
   或者在 Claude Code 中运行 `/tlive`。

2. 在 Telegram 里给机器人发一条消息
3. 如果收到回复，说明配置成功！

<!-- TODO: screenshot of successful interaction -->

## 推荐的机器人设置

向 **@BotFather** 发送以下命令：

| 命令 | 设置 | 作用 |
|------|------|------|
| `/setprivacy` | 选择你的机器人 → `Disable` | 让机器人能读取群聊中的消息 |

> **注意：** 不再需要手动 `/setcommands` —— tlive 启动时会自动注册命令菜单（`/new`、`/status`、`/help` 等）。

## 功能与配置

### 群组 @提及过滤

在群聊中，机器人默认只响应 **@提及** 消息，避免对群内每条消息都做出回应。

```env
TL_TG_REQUIRE_MENTION=true    # 默认：只响应 @机器人
TL_TG_REQUIRE_MENTION=false   # 响应群内所有消息
```

回复机器人消息时无需 @提及。

### 配对模式

如果没有设置 `TL_TG_ALLOWED_USERS`，机器人会进入**配对模式**：

1. 陌生用户发消息 → 机器人回复 6 位配对码
2. 管理员在任意已授权渠道运行 `/approve <code>`
3. 该用户获得授权，可以正常交互

使用 `/pairings` 查看待审批列表。配对码 1 小时后过期。

### 论坛话题 (Topics)

机器人支持 Telegram 论坛式群组的话题功能，消息会自动路由到正确的话题中。

### Webhook 模式（可选）

默认使用长轮询。如需切换为 webhook（适用于生产环境）：

```env
TL_TG_WEBHOOK_URL=https://your-domain.com/telegram-webhook
TL_TG_WEBHOOK_SECRET=你的随机密钥
TL_TG_WEBHOOK_PORT=8443
```

### 链接预览

默认禁用链接预览以保持消息简洁。如需启用：
```env
TL_TG_DISABLE_LINK_PREVIEW=false
```

### 代理

如果所在地区无法访问 `api.telegram.org`：
```env
TL_TG_PROXY=socks5://127.0.0.1:1080
```

## 常见问题

**机器人没有响应**
- 仔细检查 Token 是否正确（注意有没有多余的空格或遗漏的字符）
- 运行 `tlive doctor` 检查配置是否正常

**Chat ID 不对**
- 确认你先给机器人发了消息，再刷新 `getUpdates` 链接
- 如果是群聊，确认机器人已被添加到群里

**出现「Unauthorized」错误**
- Token 可能已经在 BotFather 中被重新生成了，回去复制最新的 Token
- 每次重置 Token 后，旧 Token 会立即失效

**机器人在群聊中不响应**
- 检查隐私模式是否已禁用：BotFather → `/setprivacy` → Disable
- 更改隐私设置后，需要将机器人从群组中移除再重新添加
- 如果 `TL_TG_REQUIRE_MENTION=true`（默认），需要 @提及 机器人

**启动时出现权限警告**
- 这是正常的信息提示。机器人启动时会检测自身权限，并对潜在问题发出警告
- 常见警告："Group Privacy not disabled" — 参考上方说明
