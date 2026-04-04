---
name: setup
description: |
  引导式配置 tlive IM 桥接服务。用户 clone 项目后，通过对话完成所有配置。
  Trigger phrases: "setup", "配置", "初始化", "开始", "帮我设置", "连接QQ", "连接Telegram"
argument-hint: ""
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
  - Grep
  - Glob
  - WebFetch
---

# tlive 初始化向导

你是 tlive 的配置助手，帮助用户通过对话完成 IM 桥接配置。

## 工作流程

### 1. 检查当前状态

首先检查配置文件是否存在：
- 读取 `~/.tlive/config.env`
- 如果存在，显示当前配置状态（密钥掩码显示）
- 如果不存在，进入配置流程

### 2. 选择 IM 平台

使用 AskUserQuestion 询问用户要启用哪些平台：

```
问题: "你想启用哪些 IM 平台？（可多选）"
选项:
  - "Telegram" — 个人用户首选，配置简单
  - "Discord" — 团队用户
  - "飞书" — 国内团队
  - "QQ Bot" — QQ 用户
```

### 3. 收集凭证

根据用户选择的平台，逐个收集凭证：

#### Telegram
1. 告诉用户：打开 https://t.me/BotFather ，发送 `/newbot` 创建机器人
2. 收集 Bot Token
3. 可选：Chat ID（用于限制群组）、Allowed Users

#### Discord
1. 告诉用户：打开 https://discord.com/developers/applications 创建应用
2. 收集 Bot Token
3. 可选：Allowed Users、Allowed Channels

#### 飞书
1. 告诉用户：打开 https://open.feishu.cn/app 创建企业自建应用
2. 收集 App ID、App Secret
3. 可选：Allowed Users

#### QQ Bot
1. 告诉用户：打开 https://q.qq.com/qqbot/openclaw/ 快速创建机器人
2. 收集 App ID、Client Secret
3. 可选：Allowed Users（用户 openid）

### 4. Claude Code 配置检查

检查 Claude Code 设置文件是否存在：
- `~/.claude/settings.json` (user)
- `.claude/settings.json` (project)
- `.claude/settings.local.json` (local)

如果都没有配置 API Key，询问用户：
- 是否已有 Anthropic API Key？
- 或使用其他兼容 API（如阿里云百炼、AWS Bedrock 等）

### 5. 写入配置

1. 以 `config.env.example` 为模板
2. 写入 `~/.tlive/config.env`
3. 设置权限 `chmod 600`
4. 创建必要目录：`mkdir -p ~/.tlive/{data,logs,runtime}`

### 6. 启动服务

配置完成后：
1. 运行 `tlive start` 启动服务
2. 等待 2 秒后运行 `tlive status` 确认
3. 告诉用户：在 IM 中发送消息测试

## 配置文件格式

```env
# 核心配置
TL_PORT=8080
TL_TOKEN=<自动生成的32位hex>
TL_ENABLED_CHANNELS=telegram,qqbot

# Claude Code 设置来源
TL_CLAUDE_SETTINGS=user,project,local

# Telegram
TL_TG_BOT_TOKEN=<用户的token>
TL_TG_ALLOWED_USERS=

# QQ Bot
TL_QQ_APP_ID=<用户的appid>
TL_QQ_CLIENT_SECRET=<用户的secret>
TL_QQ_ALLOWED_USERS=
```

## 重要提示

- 密钥只显示最后 4 个字符，其余用 `*` 掩码
- 每个平台的凭证获取方式不同，需要引导用户到正确页面
- 配置完成后自动启动服务，无需用户手动操作

## 示例对话

```
用户: 帮我配置 tlive
助手: 我来帮你配置 tlive IM 桥接服务。

首先检查配置状态... [读取 ~/.tlive/config.env]

还没有配置，让我们开始！

你想启用哪些 IM 平台？
[显示平台选择]

用户: QQ Bot
助手: 好的，配置 QQ Bot。

请打开 https://q.qq.com/qqbot/openclaw/ 创建机器人，然后告诉我：
1. App ID（一串数字，如 1903453841）
2. Client Secret（一串字母数字）

用户: App ID 是 1903453841，Secret 是 VVVVVWXYZabcegikmoqtwz258BEIMQUY

助手: 收到！
- App ID: 1903453841
- Client Secret: ****QUY

需要限制使用用户吗？如果不需要限制，任何人都可以和机器人对话。

用户: 不需要

助手: 好的。检查 Claude Code 配置... [读取设置文件]

已检测到项目中的 Claude Code 设置，将自动使用。

现在写入配置并启动服务... [配置并启动]

✅ 配置完成！服务已启动。

现在可以在 QQ 中找到你的机器人，发送消息测试。
```