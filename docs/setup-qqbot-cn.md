# QQ Bot 配置指南

[返回入门指南](getting-started-cn.md)

本指南将带你完成 QQ Bot 的创建和配置，将其连接到 tlive。

## 前置条件

- 一个 QQ 账号
- 大约 5 分钟

## 第一步：创建机器人应用

1. 打开 QQ 开放平台机器人管理页面：
   https://q.qq.com/qqbot/openclaw/
2. 登录你的 QQ 账号
3. 点击 **创建机器人**
4. 填写机器人信息：
   - **机器人名称：** 例如「tlive」或「终端助手」
   - **机器人简介：** 简短说明即可
5. 点击 **确认创建**

> **提示：** 使用 https://q.qq.com/qqbot/openclaw/ 可以快速创建机器人，无需复杂配置。

## 第二步：获取凭证

1. 创建机器人后，进入机器人详情页
2. 在 **开发设置** 或 **基本信息** 中找到：
   - **App ID** — 一串数字，例如 `1903453841`
   - **Client Secret** — 一串字母数字组合
3. 复制这两个值并妥善保存，第三步会用到

> **提示：** 请妥善保管 Client Secret。任何拥有 App ID 和 Client Secret 的人都可以操控你的机器人。

## 第三步：配置 tlive

你有三种方式：

**方式 A — 交互式设置：**
```bash
tlive setup
```
按提示选择 QQ Bot，然后粘贴 App ID 和 Client Secret。

**方式 B — AI 引导设置（推荐）：**
```
/tlive setup
```
在 Claude Code 中运行，获得引导式配置体验。

**方式 C — 手动配置：**

编辑 `~/.tlive/config.env`：
```env
TL_ENABLED_CHANNELS=qqbot
TL_QQ_APP_ID=你的AppID
TL_QQ_CLIENT_SECRET=你的ClientSecret
TL_QQ_ALLOWED_USERS=openid1,openid2
```

**配置项说明：**

| 配置项 | 说明 | 必需 |
|--------|------|------|
| `TL_QQ_APP_ID` | QQ Bot 的 App ID | 是 |
| `TL_QQ_CLIENT_SECRET` | QQ Bot 的 Client Secret | 是 |
| `TL_QQ_ALLOWED_USERS` | 允许使用的用户 openid（逗号分隔） | 否，留空允许所有人 |
| `TL_QQ_PROXY` | 代理地址（如 `http://127.0.0.1:7890`） | 否 |

## 第四步：配置 Claude Code

tlive 需要知道如何连接 Claude Code。有两种方式：

**方式 1 — 使用 Claude Code 设置文件（推荐）**

如果你已在项目中配置了 Claude Code，tlive 会自动读取设置。在项目根目录创建 `.claude/settings.local.json`：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "你的API密钥",
    "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
    "ANTHROPIC_MODEL": "claude-sonnet-4-6"
  }
}
```

然后在 `~/.tlive/config.env` 中指定设置来源：

```env
TL_CLAUDE_SETTINGS=user,project,local
```

**设置来源说明：**

| 来源 | 路径 | 用途 |
|------|------|------|
| `user` | `~/.claude/settings.json` | 全局认证和模型配置 |
| `project` | `.claude/settings.json` + `CLAUDE.md` | 项目规则、MCP、技能 |
| `local` | `.claude/settings.local.json` | 开发者本地覆盖 |

**方式 2 — 直接在 tlive 配置中设置**

编辑 `~/.tlive/config.env`：

```env
ANTHROPIC_API_KEY=你的API密钥
```

> **注意：** 如果使用自定义 API 端点（如阿里云百炼），需要在设置文件中配置 `ANTHROPIC_BASE_URL`。

## 第五步：验证

1. 启动 bridge：
   ```bash
   tlive start
   ```
   或在 Claude Code 中运行 `/tlive`。

2. 在 QQ 中找到你的机器人：
   - 私聊机器人发送消息
   - 或在群聊中 @机器人

3. 发送一条消息（例如「你好」）
4. 如果收到回复，说明配置成功！

## 支持的消息类型

QQ Bot 支持以下消息场景：

| 类型 | 说明 |
|------|------|
| C2C 私聊 | 直接与机器人对话 |
| 群聊 @ | 在群聊中 @机器人 |
| 频道消息 | QQ 频道中的消息 |
| 频道私信 | QQ 频道内的私信 |

## 权限审批

当 Claude 需要执行敏感操作时，QQ Bot 会发送带按钮的消息：

```
🔐 Permission Required

**Tool:** `Bash`
```
rm -rf /tmp/test
```

⏱ Expires in 5 minutes

[✅ Yes]  [❌ No]
```

点击按钮或回复 `allow` / `deny` 进行审批。

## 常见问题

**「invalid appid or secret」错误**
- 检查 App ID 和 Client Secret 是否正确复制
- 确认没有多余的空格或换行

**收不到消息**
- 确认 `TL_ENABLED_CHANNELS` 包含 `qqbot`
- 查看 tlive 日志中是否有连接错误
- 确认机器人已上线

**机器人没有回复**
- 检查 Claude Code 设置是否正确配置
- 查看 tlive 日志中是否有 API 错误

**如何获取用户 openid**
- 当用户发送消息时，tlive 日志中会显示 openid
- 可以将 openid 添加到 `TL_QQ_ALLOWED_USERS` 进行授权

## 代理配置

如果需要通过代理访问 QQ Bot API：

```env
# 全局代理（影响所有平台）
TL_PROXY=http://127.0.0.1:7890

# 仅 QQ Bot 使用代理
TL_QQ_PROXY=socks5://127.0.0.1:1080
```

> **注意：** WebSocket 连接可能需要系统级代理（如 TUN 模式）才能正常工作。