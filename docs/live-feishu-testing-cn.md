# 本地真实飞书入站测试

本文记录如何在本地自动触发一条真实飞书消息，让它经过：

```text
测试用户 -> 飞书 OpenAPI -> tlive bot WebSocket 事件 -> 本地 tlive
```

这条链路用于替代“人手动在飞书里给机器人发消息”的 smoke test。它不是 CI/CD
方案，默认只在本地开发机使用。

## 适用场景

适合验证：

- `im.message.receive_v1` 是否能真实推到本地 tlive
- tlive 是否能收到用户消息并执行 `/home`、普通提问等命令
- 飞书卡片、回调、线程、权限按钮等真实环境行为是否可继续人工或半自动验证

不适合替代：

- 单元测试：继续用 `npm test`
- 内部高保真 E2E：继续用 `npm run test:e2e`
- 纯 bot 出站测试：bot 使用 `tenant_access_token` 发消息不能模拟用户入站

关键区别：

```text
tenant_access_token -> bot 身份发消息，不能模拟用户给 bot 发消息
user_access_token   -> 测试用户身份发消息，可触发真实入站链路
```

## 飞书应用配置

先按 [飞书配置指南](setup-feishu-cn.md) 创建自建应用、获取 `App ID` /
`App Secret`、配置长连接事件订阅，并发布审批。

在此基础上，为本地真实入站测试额外确认下面几项。

### 1. 权限管理

普通 tlive bot 权限仍然需要：

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

本地自动触发“用户发消息”还需要给应用开通用户态权限：

```text
im:message
im:message.send_as_user
offline_access
```

说明：

- `im:message`：允许读写单聊、群组消息。
- `im:message.send_as_user`：允许用授权用户身份发送消息。
- `offline_access`：允许返回 `refresh_token`，避免每次都重新登录授权。

新增权限后通常需要重新创建版本、发布并通过管理员审批。

### 2. 事件订阅

事件与回调里继续使用长连接 WebSocket，并订阅：

```text
im.message.receive_v1
card.action.trigger
```

`im.message.receive_v1` 是本测试的核心：测试脚本用用户身份发消息后，tlive bot
需要通过这个事件收到消息。

### 3. OAuth 重定向 URL

在开发者后台的安全设置中添加重定向 URL：

```text
http://localhost:8788/oauth/callback
```

必须和本地脚本生成的 URL 完全一致，包括协议、域名、端口和路径。

如果在 WSL 中运行，优先仍然使用 `localhost`。若授权成功后浏览器无法访问本地回调，
再改用 `127.0.0.1` 或 WSL IP，并同步设置脚本环境变量：

```bash
TL_FS_OAUTH_REDIRECT_URI=http://127.0.0.1:8788/oauth/callback npm run live:feishu:auth
```

## 本地配置

`~/.tlive/config.env` 至少需要：

```env
TL_FS_APP_ID=cli_xxx
TL_FS_APP_SECRET=xxx
```

测试用户 token 和测试群 ID 会写到独立文件：

```text
~/.tlive/live-test.env
```

这个文件包含 `user_access_token` / `refresh_token`，不要提交到仓库。

## 获取测试用户 token

运行：

```bash
npm run live:feishu:auth
```

脚本会：

1. 在本地启动 OAuth callback server：`http://localhost:8788/oauth/callback`
2. 打开飞书授权页
3. 等待测试用户登录并授权
4. 用授权码换取 `user_access_token` 和 `refresh_token`
5. 保存到 `~/.tlive/live-test.env`

授权成功后会看到类似输出：

```text
[live-feishu-auth] saved token to /home/user/.tlive/live-test.env
[live-feishu-auth] access token eyJhbG...xxxx
[live-feishu-auth] refresh token saved
```

常见错误：

- `20029`：重定向 URL 未加入飞书应用安全设置，或和脚本 URL 不完全一致。
- `20027`：授权链接请求了应用后台未开通的权限。
- `20010`：当前登录用户没有应用使用权限，需要调整应用可用范围或完成审批。

## 配置测试群 ID

脚本需要知道向哪个飞书群或会话发消息。将测试群 ID 写入：

```env
TL_FS_TEST_CHAT_ID=oc_xxx
```

如果本地 tlive 曾经收到过这个群的消息，可以从日志里找完整 `oc_...`：

```bash
rg -o 'oc_[A-Za-z0-9_-]+' ~/.tlive/logs
```

然后追加到 `~/.tlive/live-test.env`：

```bash
printf "\nTL_FS_TEST_CHAT_ID='oc_xxx'\n" >> ~/.tlive/live-test.env
chmod 600 ~/.tlive/live-test.env
```

## 发送测试消息

确保本地 tlive 已经启动：

```bash
npm start
```

另开一个终端，发送 `/home`：

```bash
npm run live:feishu:send -- "/home"
```

也可以发送普通问题：

```bash
npm run live:feishu:send -- "现在在哪个目录"
```

发送成功会输出：

```text
[live-feishu-send] sent "/home" to chat_id:oc_xxx; message_id=om_xxx
```

## 验证 tlive 确实收到真实入站事件

查看当天日志：

```bash
tail -n 50 ~/.tlive/logs/bridge-$(date +%F).log
```

成功时应该看到类似：

```text
[feishu] INFO: ... RECV user=... chat=...: /home
[bridge] INFO: ... CMD /home
```

这表示消息不是直接注入测试 harness，而是通过飞书真实事件进入了本地 tlive。

## 参考文档

- 飞书获取授权码：<https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code?lang=zh-CN>
- 飞书获取 `user_access_token`：<https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token>
- 飞书发送消息：<https://open.feishu.cn/document/server-docs/im-v1/message/create?lang=zh-CN>
- 飞书接收消息事件：<https://open.feishu.cn/document/server-docs/im-v1/message/events/receive?lang=zh-CN>
