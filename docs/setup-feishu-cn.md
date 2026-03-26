# 飞书配置指南

[返回入门指南](getting-started-cn.md)

本指南将带你完成飞书自建应用的创建和配置，将其连接到 tlive。飞书的配置步骤比其他平台稍多——你需要创建应用、配置权限、设置事件订阅，并通过管理员审批。别担心，本指南会详细说明每一步。

## 前置条件

- 一个飞书账号（国际版用户使用 Lark）
- 拥有创建应用的管理员权限，或者可以请管理员帮忙审批
- 大约 10 分钟

## 第一步：创建自建应用

1. 打开飞书开放平台开发者后台：
   - **飞书（中国版）：** https://open.feishu.cn/app
   - **Lark（国际版）：** https://open.larksuite.com/app
2. 登录你的飞书账号
3. 点击 **创建自建应用**
4. 填写应用信息：
   - **应用名称：** 例如「tlive」或「终端助手」
   - **应用描述：** 简短说明即可，例如「tlive 终端会话桥接机器人」
5. 点击 **创建**

<!-- TODO: 「创建自建应用」按钮和表单的截图 -->

> **提示：** 如果看不到「创建自建应用」按钮，说明你的企业管理员可能限制了应用创建权限。请联系管理员帮你创建应用，或授予你开发者权限。

## 第二步：获取凭证

1. 创建应用后，会进入应用的概览页面
2. 在左侧菜单中点击 **凭证与基础信息**
3. 你会看到两个值：
   - **App ID** — 格式类似 `cli_xxxxxxxxxxxxxxxx`
   - **App Secret** — 一串较长的字母数字组合
4. 复制这两个值并妥善保存，第六步会用到

<!-- TODO: 凭证与基础信息页面的截图，标注 App ID 和 App Secret -->

> **提示：** 请妥善保管 App Secret。任何拥有 App ID 和 App Secret 的人都可以操控你的机器人。

## 第三步：添加权限

应用需要权限才能收发消息。

1. 在左侧菜单中，点击 **权限管理**
2. 点击 **批量开通**，粘贴以下 JSON 一键导入所有需要的权限：

```json
{
  "scopes": {
    "tenant": [
      "cardkit:card:read",
      "cardkit:card:write",
      "im:chat:readonly",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ]
  }
}
```

**权限说明：**

| 权限标识 | 说明 | 必要性 |
|---|---|---|
| `im:message` | 收发消息 | 必需 |
| `im:message:send_as_bot` | 以机器人身份发消息 | 必需 |
| `im:chat:readonly` | 读取群组基本信息 | 必需 |
| `im:message:readonly` | 读取消息内容 | 必需 |
| `im:message.p2p_msg:readonly` | 读取私聊消息 | 必需 |
| `im:message.group_at_msg:readonly` | 读取群聊 @机器人 消息 | 推荐 |
| `cardkit:card:read` | 读取卡片信息 | 推荐 |
| `cardkit:card:write` | CardKit 流式卡片 | 推荐 |
| `im:resource` | 上传图片和文件 | 可选 |

3. 确认权限都出现在权限列表中

> **提示：** 使用批量导入方式可一次性开通所有权限，无需逐个搜索。

## 第四步：配置事件订阅

这一步告诉飞书，当有人给机器人发消息时通知 tlive。

1. 在左侧菜单中，点击 **事件与回调**
2. 在 **事件订阅** 区域，点击 **添加事件**
3. 添加以下事件：
   - `im.message.receive_v1`（接收消息）
   - `card.action.trigger`（卡片按钮交互回调）
4. 设置 **回调方式**：
   - 选择 **长连接（WebSocket）**
   - **不要**选择 HTTP 回调——tlive 使用 WebSocket 模式，不需要你配置公网地址

<!-- TODO: 事件与回调页面的截图，显示已选择长连接模式 -->

> **为什么选长连接？** 使用长连接模式时，tlive 主动连接飞书服务器。这意味着你不需要公网 IP、域名或做任何防火墙配置，在任何网络环境下都能直接使用。

## 第五步：发布并审批

飞书应用在发布并通过管理员审批后才会生效。

1. 在左侧菜单中，点击 **版本管理与发布**
2. 点击 **创建版本**
3. 填写信息：
   - **版本号：** 例如 `1.0.0`
   - **更新说明：** 例如「首次发布——终端会话桥接机器人」
   - **可用范围：** 选择哪些用户/部门可以使用该应用，或选择「全部成员」
4. 点击 **保存** 然后 **提交审核**
5. 需要企业管理员审批该应用：
   - 管理员打开 **飞书管理后台**（https://feishu.cn/admin）
   - 找到 **应用审核** 或 **企业应用**
   - 找到你的应用，点击 **通过**

<!-- TODO: 创建版本页面的截图 -->
<!-- TODO: 管理后台审批页面的截图 -->

> **如果你就是管理员：** 提交后可以在管理后台立即自行审批。

> **如果你不是管理员：** 告知管理员你已提交应用，他们会在管理后台看到待审批通知。

## 第六步：配置 tlive

你有三种方式：

**方式 A — 交互式设置：**
```bash
tlive setup
```
按提示选择飞书，然后粘贴 App ID 和 App Secret。

**方式 B — AI 引导设置（推荐）：**
```
/tlive setup
```
在 Claude Code 中运行，获得引导式配置体验。

**方式 C — 手动配置：**

编辑 `~/.tlive/config.env`：
```env
TL_ENABLED_CHANNELS=feishu
TL_FS_APP_ID=cli_xxxxxxxxxxxxxxxx
TL_FS_APP_SECRET=你的-app-secret
TL_FS_ALLOWED_USERS=ou_xxxxxxxxxxxxxxxx
```

`TL_FS_ALLOWED_USERS` 是可选项。设置后，只有列出的用户 Open ID 才能与机器人交互。留空则允许企业内所有成员使用。

> **如何获取用户 Open ID：** 当有人给机器人发消息时，tlive 日志中会显示该用户的 Open ID。你也可以在飞书管理后台的成员管理中查找，或通过[飞书 API](https://open.feishu.cn/document/server-docs/contact-v3/user/get) 获取。

## 第七步：验证

1. 启动 bridge：
   ```bash
   tlive start
   ```
   或在 Claude Code 中运行 `/tlive`。

2. 打开飞书，找到你的机器人：
   - 搜索第一步中设置的应用名称
   - 或在通讯录中查看——机器人会出现在 **机器人** 或 **应用** 分类下
3. 给机器人发一条私聊消息（例如「你好」）
4. 你应该会看到一个交互卡片形式的回复——如果收到了，说明配置成功！

<!-- TODO: 飞书中机器人成功交互的截图 -->

> **找不到机器人？** 应用必须先完成发布和审批（第五步），才会以机器人形态出现在飞书中。如果你刚提交审核，请等待管理员通过。

## Lark 国际版

如果你使用 Lark 而非飞书，所有步骤完全相同。唯一的区别：

- 开发者后台地址为 https://open.larksuite.com/app
- 管理后台地址为 https://larksuite.com/admin
- 界面默认为英文

所有环境变量名称、权限标识和事件名称完全一致。

## 常见问题

**「应用未审批」/ 找不到机器人**
- 应用必须完成发布（第五步）并通过管理员审批才会生效
- 请在管理后台查看是否有待审批的应用

**收不到事件 / 机器人没有响应**
- 确认第四步中选择了 **长连接（WebSocket）**，而不是 HTTP 回调
- 确认已添加 `im.message.receive_v1` 和 `card.action.trigger` 事件
- 检查 `TL_FS_APP_ID` 和 `TL_FS_APP_SECRET` 是否正确（注意没有多余空格）

**权限不足错误**
- 确认第三步中通过批量导入开通的权限都已出现在权限列表中
- 权限在应用发布审批后才生效——如果是后来新增的权限，需要创建新版本并重新审批

**「无效的 App ID」或「无效的 App Secret」**
- 仔细检查第二步中复制的值是否完整
- 确认使用的是正确应用的凭证（如果你创建了多个应用）
- 运行 `tlive doctor` 检查配置

**飞书中机器人有回复但 tlive 没反应**
- 确认 `TL_ENABLED_CHANNELS` 包含 `feishu`
- 查看 tlive 日志中是否有连接错误信息
