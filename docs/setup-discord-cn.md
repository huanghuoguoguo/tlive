# Discord 配置指南

[返回入门指南](getting-started-cn.md)

本指南将带你一步步创建 Discord 机器人，并将其连接到 tlive，让你可以通过 Discord 监控和操作终端会话。

## 前置条件

- 一个 Discord 账号
- 一个你拥有管理员权限的 Discord 服务器（也可以免费新建一个）
- 大约 5 分钟时间

## 第一步：创建 Discord 应用

1. 打开 [Discord 开发者后台](https://discord.com/developers/applications)
2. 点击右上角的 **New Application**
3. 输入名称（比如 "tlive"），点击 **Create**

<!-- ![新建应用按钮](images/discord-new-app.png) -->

创建完成后会自动跳转到应用设置页面。

## 第二步：创建机器人

1. 点击左侧栏的 **Bot** 标签页
2. 点击 **Reset Token**，确认后会生成新的令牌
3. **立刻复制令牌** —— 之后无法再次查看（如果忘记保存，可以重新生成）

接下来，向下滚动到 **Privileged Gateway Intents**，开启以下选项：

- **Message Content Intent** —— 机器人读取消息内容必须开启此项

<!-- ![Message Content Intent 开关](images/discord-intents.png) -->

> **重要提示：** 如果没有开启 Message Content Intent，机器人可以连接但无法读取任何消息内容。这是最常见的配置问题。

## 第三步：设置权限并邀请机器人

1. 点击左侧栏的 **OAuth2** 标签页，再点击 **URL Generator**
2. 在 **Scopes** 中勾选 `bot`
3. 在 **Bot Permissions** 中勾选：
   - **Send Messages**（发送消息）
   - **Read Message History**（读取消息历史）
   - **Manage Messages**（管理消息）
   - **Add Reactions**（添加表情回应）
   - **Create Public Threads**（创建公开帖子）
4. 复制页面底部生成的 **Generated URL**

<!-- ![OAuth2 URL 生成器](images/discord-oauth2.png) -->

在浏览器中打开该链接，选择你要添加机器人的服务器，点击 **Authorize** 即可。

机器人现在会出现在服务器的成员列表中（在启动 tlive 之前会显示为离线状态）。

## 第四步：获取用户 ID 和频道 ID

Discord 内部使用数字 ID。你需要获取你的用户 ID（必填），以及频道 ID（选填）。

### 开启开发者模式

1. 打开 Discord，进入 **用户设置**（用户名旁边的齿轮图标）
2. 找到 **Advanced**（高级）
3. 开启 **Developer Mode**（开发者模式）

### 复制你的用户 ID

- 右键点击自己的用户名（在聊天区或成员列表中）
- 点击 **Copy User ID**（复制用户 ID）

### 复制频道 ID（可选）

- 右键点击左侧栏的频道名称
- 点击 **Copy Channel ID**（复制频道 ID）

设置允许的频道后，机器人只会在指定频道中响应消息。

> **安全提示：** 建议至少设置允许的用户 ID 或频道 ID 之一。否则服务器内的任何人都可以与机器人交互。

## 第五步：配置 tlive

你有三种方式：

### 方式 A：交互式配置（最简单）

```bash
tlive setup
```

按提示选择 "Discord"，然后粘贴你的令牌和 ID。

### 方式 B：Claude Code 斜杠命令（推荐 Claude Code 用户使用）

在 Claude Code 中运行 `/tlive setup`，按提示操作即可。

### 方式 C：手动编辑配置文件

编辑 `~/.tlive/config.env`：

```env
TL_ENABLED_CHANNELS=discord
TL_DC_BOT_TOKEN=你的机器人令牌
TL_DC_ALLOWED_USERS=你的用户ID
TL_DC_ALLOWED_CHANNELS=频道ID  # 可选
```

如果需要设置多个用户或频道，用英文逗号分隔：

```env
TL_DC_ALLOWED_USERS=111111111,222222222
TL_DC_ALLOWED_CHANNELS=333333333,444444444
```

## 第六步：验证是否正常工作

1. 启动 bridge：
   ```bash
   tlive start
   ```
   或者在 Claude Code 中使用 `/tlive`。

2. 机器人应该在你的 Discord 服务器中变为在线状态
3. 在机器人所在的频道发送一条消息
4. 你应该能看到回复，说明连接成功

## 功能特性

### 自动 Thread

当你发送消息时，机器人会从第一条回复自动创建 **Thread（帖子）**。同一会话的后续消息都在该 Thread 中，保持主频道整洁。使用 `/new` 开始新会话（同时创建新 Thread）。

### 表情回应

机器人用表情回应展示处理状态：
- 🤔 正在处理你的消息
- 👍 处理完成
- ❌ 出现错误

### 文本审批

除了点击按钮，还可以回复 `allow` 或 `deny` 来审批权限请求（适用于按钮过期的情况）。

### Embed 样式输出

`/status`、`/help`、`/sessions` 等命令以 Discord 富文本 Embed 格式呈现，更加美观。

## 常见问题

**机器人显示离线**
- 检查机器人令牌是否正确
- 确认已开启 **Message Content Intent**（第二步）
- 确认 tlive 正在运行（`tlive status`）

**出现 "Missing Access" 或 "Missing Permissions" 错误**
- 机器人需要 Send Messages、Read Message History、Manage Messages、Add Reactions 和 Create Public Threads 权限
- 如果频道设置了自定义权限覆盖，确保机器人的角色被正确授权
- 机器人启动时会检查权限，缺少的权限会输出到日志中

**机器人在线但不回复消息**
- 这几乎总是因为 **Message Content Intent** 没有开启 —— 回到开发者后台的 Bot 页面开启它
- 确认你的用户 ID 在允许的用户列表中
- 如果设置了允许的频道，确认你在正确的频道中发送消息

**启动时提示 "Invalid token" 错误**
- 令牌格式类似 `MTIzNDU2Nzg5.Gh7x2A.xxxxx...`，确保完整复制了整个令牌
- 如果重新生成了令牌，记得更新配置文件中的值
