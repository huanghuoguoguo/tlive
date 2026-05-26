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
im:resource:upload
offline_access
```

说明：

- `im:message`：允许读写单聊、群组消息。
- `im:message.send_as_user`：允许用授权用户身份发送消息。
- `im:resource:upload`：允许用授权用户身份上传测试文件，再作为 file 消息发入话题。
  如果后台只提供粗粒度权限，也可以使用 `im:resource`。
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

`~/.tlive/server.env` 至少需要：

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
- `99991677`：`user_access_token` 过期。先尝试刷新：

  ```bash
  npm run live:feishu:auth -- --refresh
  ```

  如果 refresh token 也过期，再执行完整浏览器授权。

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

## 发送话题回复

真实 agent 任务应在话题内执行。主窗口只处理 TLive 命令；如果把普通任务发到主窗口，
tlive 会返回：

```text
⚠️ 主窗口只处理 TLive 命令。请用 /home 打开工作台并点击新建会话，或使用 /new claude 创建话题。
```

先创建话题：

```bash
npm run live:feishu:send -- "/new codex vm-0-16-ubuntu"
```

然后向最新 Codex 话题发回复：

```bash
npm run live:feishu:reply -- --latest codex "/pwd"
```

也可以指定某个话题的 `rootMessageId`：

```bash
npm run live:feishu:reply -- --root om_xxx "/bash pwd"
```

`--latest [provider]` 会从 `~/.tlive/runtime/topic-sessions.json` 选择最近更新的话题。
注意两点：

- `npm run live:feishu:send -- "/new ..."` 输出的 `message_id` 是用户发送 `/new`
  这条消息的 ID，不一定是新话题 root。新话题 root 应从
  `~/.tlive/runtime/topic-sessions.json` 的 `rootMessageId` 取，或直接使用
  `live:feishu:reply -- --latest <provider>`。
- 不要把多条依赖顺序的消息批量连发，例如 `/cd`、`/perm on`、真实任务。飞书事件
  到达和处理存在异步性，测试脚本应逐条发送，并等日志或页面确认后再发送下一条。

### 测试脚本的 `--help` 不能发真实消息

本轮踩过一次工具坑：早期 `live:feishu:send -- --help` 和 `live:feishu:reply -- --help`
没有真正的 help 分支，会把 `--help` 当成真实飞书消息发出去。现在脚本已修复，后续改这些
live helper 时要保留这个行为：

```bash
npm run -s live:feishu:send -- --help
npm run -s live:feishu:reply -- --help
npm run -s live:feishu:upload-file -- --help
```

验收信号是只打印 usage，不出现 `[live-feishu-send] sent ...` 或
`[live-feishu-reply] replied ...`。

## 发送文件到话题

文件入站测试需要先用用户 token 上传文件，再把返回的 `file_key` 作为 file 消息回复到话题。
脚本封装了这两个步骤：

```bash
printf 'marker=qa-file-in\nsource=user-file-message\n' > /tmp/qa-file-in.txt
npm run live:feishu:upload-file -- --latest claude /tmp/qa-file-in.txt
```

也可以指定话题 root：

```bash
npm run live:feishu:upload-file -- --root om_xxx /tmp/qa-file-in.txt
```

注意：文件消息本身通常会先被 tlive 缓存，等待后续文字消息合并后再交给 agent。因此上传
文件后，再发送一条文字任务：

```bash
npm run live:feishu:reply -- --latest claude \
  "请读取刚才上传的 txt 附件，并只回复其中的 marker 值。"
```

如果上传阶段返回：

```text
code=99991679
required one of these privileges under the user identity: [im:resource:upload, im:resource]
```

说明飞书应用缺少用户态资源上传权限。需要在开发者后台添加 `im:resource:upload` 或
`im:resource`，重新发布审批，然后重新执行：

```bash
npm run live:feishu:auth
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

## 浏览器真实点击测试

API 可以触发真实消息入站，但不能代替用户点击飞书卡片按钮。卡片按钮需要走真实飞书
Web 客户端：

```text
Windows Chrome -> 用户点击卡片按钮 -> 飞书 card.action.trigger -> 本地 tlive
```

在 WSL 中建议启动一个单独 profile 的 Windows Chrome，并开启 DevTools 远程调试端口：

```bash
'/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' -NoProfile -Command \
  '$profile = Join-Path $env:TEMP "tlive-feishu-chrome-profile"; \
   New-Item -ItemType Directory -Force $profile | Out-Null; \
   Start-Process -FilePath "C:\Program Files\Google\Chrome\Application\chrome.exe" \
   -ArgumentList @("--remote-debugging-port=9222", \
                   "--remote-debugging-address=0.0.0.0", \
                   "--user-data-dir=$profile", \
                   "--no-first-run", \
                   "--new-window", \
                   "https://t05iegbxtq9.feishu.cn/next/messenger")'
```

验证 WSL 能连接这个 Chrome：

```bash
curl -s http://127.0.0.1:9222/json/version
curl -s http://127.0.0.1:9222/json/list
```

如果能看到 `webSocketDebuggerUrl`，就可以通过 CDP 控制同一个 Windows Chrome 窗口。

仓库里提供了一个轻量 CDP 辅助脚本，优先用它做按钮定位和点击：

```bash
# 查看当前可见按钮，支持按文本过滤
npm run live:feishu:browser -- list 回到话题

# 按包含文本定位按钮并执行 DOM click，避免坐标误点
npm run live:feishu:browser -- click 回到话题 --last
npm run live:feishu:browser -- click 开启审批

# 点击非 button 文本，例如飞书的“回复话题”
npm run live:feishu:browser -- click-text 回复话题 --last

# 把当前可见的飞书滚动容器滚到底部，便于露出最新权限按钮
npm run live:feishu:browser -- scroll-bottom

# 通过浏览器输入框发送消息
npm run live:feishu:browser -- send "/home qa-browser-$(date +%H%M%S)"

# 打印当前页面文本尾部，辅助确认页面是否停在正确会话
npm run live:feishu:browser -- text 3000
```

如果 Chrome 调试端口不是 `9222`，可以指定：

```bash
TL_FEISHU_CDP_URL=http://127.0.0.1:9333 npm run live:feishu:browser -- list
```

### WSL/Chrome 坑点

- Codex shell 的 `PATH` 可能没有 `/mnt/c/Windows/System32`，所以 `cmd.exe` /
  `powershell.exe` 可能 `command -v` 找不到。直接用绝对路径：
  `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`。
- `DISPLAY` / `WAYLAND_DISPLAY` 为空时，Linux headed browser 不会弹到桌面。应使用
  Windows Chrome，而不是指望 WSL 内 Chromium 可见。
- 普通 `Start-Process chrome.exe URL` 只会打开你可见的浏览器，但 Codex 无法控制它。
  必须加 `--remote-debugging-port=9222`。
- 不要复用日常 Chrome profile。使用 `--user-data-dir=$env:TEMP\tlive-feishu-chrome-profile`
  隔离登录态和测试状态。
- Playwright MCP 默认浏览器可能在后台或不可见；它适合截图/快照，不适合作为需要用户扫码
  登录的主通道。需要用户操作时优先用上面的 Windows Chrome + CDP。

## 建议测试矩阵

| 优先级 | 路径 | 触发方式 | 验收信号 |
|---|---|---|---|
| P0 | 主控制台 API 入站 | `npm run live:feishu:send -- "/home qa-..."` | 日志出现 `RECV ... /home qa-...` 和 `CMD /home` |
| P0 | 主控制台浏览器输入 | `npm run live:feishu:browser -- send "/home qa-browser-..."` | 日志出现对应 `RECV` 和 `CMD /home` |
| P0 | 工作台按钮点击 | `npm run live:feishu:browser -- click 查看最近会话 --last` | 日志出现 `card.action.trigger`，action 为 `action:home-history` |
| P0 | 话题内入站 | 用户 token 调 `messages/{rootMessageId}/reply`，`reply_in_thread=true` | 飞书返回 `thread_id`，日志出现对应 `RECV` |
| P1 | 话题按钮进入 | `npm run live:feishu:browser -- click 回到话题 --last` | 日志出现 `action:continue:*`，页面进入对应话题 |
| P1 | 权限模式按钮 | `/perm` 后执行 `npm run live:feishu:browser -- click 开启审批 --last` | 日志出现 `action:perm:on` / `action:perm:off` |
| P1 | 权限审批 | 构造需要审批的任务后点击允许，或在同一话题回复 `拒绝` | 日志出现 `Permission resolved ... → allow/deny` |
| P1 | 新建会话按钮 | 点击 `新建 Claude Code` / `新建 Codex` | 生成新话题，工作台/日志有新 session |
| P1 | 文件修改闭环 | 话题内让 agent 创建/修改 `result.md` | `/bash cat result.md` 能读到唯一 marker |
| P1 | 文件回传闭环 | agent 调 `tlive_send_file` 发回 `result.md` | 飞书话题收到文件或明确的 MCP 错误 |
| P1 | `/stop` 中断 | 话题内启动长任务，再在同一话题发送 `/stop` | 日志出现 `ERROR Interrupted`，飞书显示“已停止/已中断当前执行” |
| P1 | Claude 执行中插话 | 长任务运行时向同一话题追加消息 | 飞书显示“已插入当前会话”，最终回复包含插话 token |
| P1 | Codex 忙碌拒绝 | Codex 长任务运行时向同一话题追加消息 | 飞书显示“当前 provider 不支持执行中插入消息” |
| P2 | 文件入站 | `live:feishu:upload-file` 上传文件，再发送文字任务 | tlive 合并附件，agent 能读出文件 marker |
| P2 | 图片入站 | 浏览器上传图片或补充图片上传脚本 | tlive 下载图片并转发给支持图片的 provider |
| P2 | 长输出/限频 | 真实模型输出长内容 | 卡片更新稳定，无明显前端冻结 |

P0 是每次改 Feishu 入站/工作台/话题路由时都应该跑的路径。P1/P2 会改状态或触发更长任务，
建议按需跑。

## 本轮踩坑记录

### 用唯一标记区分新旧日志

历史日志里可能已经有很多 `/home`、按钮点击、话题消息。每次测试都带唯一标记：

```bash
npm run live:feishu:send -- "/home qa-$(date +%H%M%S)"
```

验收时只认同一个标记对应的 `RECV` / `CMD`，不要把历史成功记录当成新测试结果。

### 先打开会话，再验消息区

飞书 Web 首屏可能停在消息列表。此时 `document.body.innerText` 只会看到左侧会话摘要，
看不到右侧消息正文或卡片按钮。需要先点击 `openclaw` 会话，再检查：

- 最新用户消息是否出现，例如 `/home qa-...`
- 最新工作台卡片是否出现，例如 `🏠 工作台`
- 卡片按钮是否出现，例如 `查看最近会话`

### 按钮定位不要只靠文本全局搜索

飞书消息区会保留很多历史卡片，同名按钮会重复出现，例如：

- `设为默认`
- `查看最近会话`
- `回到话题`
- `恢复到话题`
- `Bridge 状态`
- `内部诊断`

全局 `querySelectorAll()` 找到的第一个按钮可能属于历史卡片，不是最新卡片。更稳的策略：

1. 先用唯一消息标记定位最新卡片附近区域。
2. 只在当前视口和最新卡片附近找按钮。
3. 点击前保存截图，确认按钮确实在可见区域。
4. 点击后用日志里的 `card.action.trigger` 验证，而不是只看前端变化。

### 可见性判断不等于可点击

本轮 `Bridge 状态` 出现过“DOM 判断可见，但坐标点击没有触发回调”的情况。随后使用
`el.scrollIntoView()` 加 `el.click()` 能触发真实飞书卡片回调：

```text
card.action.trigger ... "action":"action:status"
card.action.trigger ... "action":"action:diagnose"
```

这说明按钮业务链路是通的，问题在坐标命中。原因可能是：

- 飞书消息区域是滚动容器，不是页面全局滚动。
- DOM 坐标受虚拟列表、历史卡片、输入区遮挡影响。
- 同名按钮来自不同卡片，坐标对应的并不是当前可点击按钮。

当目标只是证明按钮回调链路通时，优先点低风险且当前截图明确可见的按钮，例如
`查看最近会话`。本轮该按钮成功触发：

```text
card.action.trigger ... "action":"action:home-history"
```

需要证明具体按钮业务时，优先用 DOM 定位目标按钮后执行：

```js
element.scrollIntoView({ block: 'center', inline: 'center' });
element.click();
```

不要直接复用一次 `getBoundingClientRect()` 计算出来的坐标长期点击。实际测试时优先使用：

```bash
npm run live:feishu:browser -- list Bridge
npm run live:feishu:browser -- click "Bridge 状态" --last
```

### 按钮文本可能带图标

权限卡里的按钮显示为：

```text
🔐 开启审批
⚡ 关闭审批
🏠 首页
```

用精确文本 `开启审批` 会找不到。选择器应使用 `text.includes('开启审批')` 或解析回调
action，而不是只做完全相等匹配。

本轮点击 `🔐 开启审批` 成功触发：

```text
card.action.trigger ... "action":"action:perm:on"
```

测试后要恢复权限模式，避免影响后续人工使用：

```bash
npm run live:feishu:send -- "/perm off"
```

### 话题测试优先用 reply API

话题 UI 入口如 `回到话题` / `恢复到话题` 受飞书 Web DOM 和历史卡片影响较大。要验证
tlive 的话题入站能力，优先使用已有话题的 `rootMessageId` 调飞书回复消息 API：

```text
POST /open-apis/im/v1/messages/{rootMessageId}/reply
```

请求体带：

```json
{
  "msg_type": "text",
  "content": "{\"text\":\"/home qa-topic-...\"}",
  "reply_in_thread": true
}
```

`rootMessageId` / `threadId` 可从本地持久化文件找：

```bash
cat ~/.tlive/runtime/topic-sessions.json
```

成功响应里应包含：

```text
thread_id=omt_...
parent_id=<rootMessageId>
root_id=<rootMessageId>
```

随后 tlive 日志应出现同一条 `/home qa-topic-...` 的 `RECV`。

本轮额外验证了一个坑：DOM 中定位到的可见 `回到话题` 按钮，用坐标点击后实际触发了
`action:home-history`，没有进入话题。这再次说明话题入口的浏览器坐标点击不够稳定。
随后改用 DOM `scrollIntoView()` + `click()` 后，日志能看到正确的 `action:continue:*`。
因此这不是 `回到话题` 按钮的产品 bug，而是坐标点击测试方式不可靠。

话题按钮测试不要手写坐标，使用：

```bash
npm run live:feishu:browser -- list 回到话题
npm run live:feishu:browser -- click 回到话题 --last
```

### 话题消息不要批量连发

本轮用 API 连续发送 `/cd`、`/perm on`、agent 任务时，日志显示任务启动时还在旧 cwd。
这类测试必须逐条发送并等待确认：

```bash
npm run live:feishu:reply -- --latest codex "/cd /tmp/smoke"
# 等日志出现 CMD /cd，或页面出现新目录

npm run live:feishu:reply -- --latest codex "/perm on"
# 等页面出现权限状态

npm run live:feishu:reply -- --latest codex "创建 result.md ..."
```

不要用一个脚本在 1-2 秒内连续打三条依赖顺序的消息，否则会得到不稳定结论。

### `/new` 的返回 message id 不是话题 root

`live:feishu:send` 返回的是用户发出的 `/new ...` 这条消息 ID。但 `/new` 实际会让 bot
另发一条“新 Remote ... 会话”作为话题标题，并基于这条 bot 消息创建话题。因此：

```text
live:feishu:send 输出 message_id=om_A  # 用户 /new 消息
topic-sessions.json rootMessageId=om_B # 真实话题 root
```

向 `om_A` 调 `messages/{message_id}/reply?reply_in_thread=true` 可能会创建或命中错误话题。
典型表现是任务消息被 tlive 当成主窗口消息处理，并返回：

```text
⚠️ 主窗口只处理 TLive 命令。请用 /home 打开工作台并点击新建会话，或使用 /new claude 创建话题。
```

需要严格进入刚创建的话题时，先读取 `topic-sessions.json`：

```bash
node - <<'NODE'
const fs = require('fs');
const p = process.env.HOME + '/.tlive/runtime/topic-sessions.json';
const rows = Object.values(JSON.parse(fs.readFileSync(p, 'utf8')))
  .filter((v) => v.provider === 'claude' && v.rootMessageId)
  .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
console.log(rows[0].rootMessageId);
NODE
```

### 真实 agent 任务必须选可用 provider/client

本轮文件修改闭环暴露了几类环境问题：

- 主窗口普通文本会被拒绝，真实 agent 任务必须在话题内执行。
- 本地 Claude 话题失败：`Claude Code native binary not found at /usr/bin/claude`。
- 本地 Codex client 失败：`Codex Exec exited with code 1: Error: No such file or directory`。
- 远端 Codex 在裸 `/tmp` 目录失败：`Not inside a trusted directory and --skip-git-repo-check was not specified.`。
- 远端 client 断连会导致 `/bash` 或 agent 任务返回：`Remote client disconnected: vm-0-16-ubuntu`。

因此文件修改 smoke 的前置检查应包括：

```bash
npm run live:feishu:send -- "/new codex vm-0-16-ubuntu"
npm run live:feishu:reply -- --latest codex "/pwd"
npm run live:feishu:reply -- --latest codex "/bash git init >/dev/null && printf 'seed=qa-file\\n' > input.txt && pwd && cat input.txt"
```

只有 provider、client、cwd、远端 shell 都确认可用后，才发送真实 agent 修改文件任务。
如果使用 Codex，测试目录应是 git worktree，或明确配置 Codex 跳过 git repo 检查。

### `/new <provider> <clientId>` 必须真的约束执行节点

本轮确认过一个真实 bug：`/new claude <clientId>` 会把 `clientId` 写入话题绑定和
`topic-sessions.json`，但会话管理层创建 `RemoteLiveSession` 时没有把 `clientId` 继续传给
provider。结果是控制面显示绑定到本机节点，实际执行端却可能按空闲度自动挑到 VM 节点。
典型现象是：

```text
本机 command -v claude 正常
话题绑定 clientId=yhh-client-...
实际任务仍报 Claude Code native binary not found at /usr/bin/claude
```

修复后需要至少跑这两条真实回归：

```bash
npm run live:feishu:send -- "/new claude <local-client-id>"
npm run live:feishu:reply -- --latest claude "请只回复：qa-claude-client-ok-$(date +%H%M%S)"

npm run live:feishu:send -- "/new codex <local-client-id>"
npm run live:feishu:reply -- --latest codex "请只回复：qa-codex-client-ok-$(date +%H%M%S)"
```

验收信号：

- `~/.tlive/runtime/topic-sessions.json` 中最新话题的 `clientId` 是指定节点。
- 日志出现 `Creating LiveSession ...` 后任务 `COMPLETE`。
- 不再出现 `/usr/bin/claude` 或 Codex `No such file or directory` 这类错误。

相关代码边界：

- `NewCommand` 负责把 `clientId` 写入 binding。
- `SessionManager.getOrCreateSession()` 必须把 `options.clientId` 传给 `llm.createSession()`。
- 若同一逻辑 session 的 `clientId` 改变，必须关闭旧 `LiveSession` 并重建，不能复用旧执行端。

### 权限审批要用会触发审批的工具

`/perm on` 并不代表所有工具都会弹审批。当前安全白名单里包括 `Write(*)`、`Edit(*)`、
`Read(*)`、`Bash(safe *)` 等，所以这些路径可能直接执行：

```text
Write approved.txt -> 直接执行
Bash pwd           -> 直接执行
```

要验证飞书权限按钮链路，使用无害但会被判定为危险的 Bash 命令，例如删除一个不存在的
测试目录子路径：

```bash
marker="qa-perm-rm-$(date +%H%M%S)"
dir="/tmp/tlive-live-qa-perm-$marker"
mkdir -p "$dir"

npm run live:feishu:reply -- --root "$root" "/cd $dir"
npm run live:feishu:reply -- --root "$root" "/perm on"
npm run live:feishu:reply -- --root "$root" \
  "权限审批测试 $marker。必须使用 Bash 工具执行：rm -rf $dir/nonexistent-permission-target && echo $marker-ok。该路径不存在，不会删除实际文件。需要审批时等待我点击允许一次。"
```

验收信号：

```text
Permission request: Bash (...)
card.action.trigger ... "action":"perm:allow:..."
Permission resolved: Bash (...) → allow
```

拒绝路径也要测。按钮定位容易被飞书 Web 的历史卡片干扰，稳定做法是在同一话题里直接
回复文本决策：

```bash
npm run live:feishu:reply -- --root "$root" "拒绝"
```

验收信号：

```text
Permission resolved: Bash (...) → deny
[query] ... DENIALS Bash
```

本轮真实拒绝用例 `qa-deny-20260523-231233` 通过：日志出现 `Permission request: Bash`、
`Permission resolved ... → deny`、`DENIALS Bash`，且任务完成后没有继续执行被拒绝的
危险 Bash。

浏览器侧如果看不到 `允许一次`，通常不是权限卡没发，而是飞书话题面板没有打开或没有滚动
到底部。先执行：

```bash
npm run live:feishu:browser -- click-text 回复话题 --last
npm run live:feishu:browser -- scroll-bottom
npm run live:feishu:browser -- list 允许
```

如果要点 `拒绝`，不要只用模糊文本匹配历史消息里的“权限拒绝测试”。先确认当前话题面板
已经打开、权限卡在可视区域，再点击权限卡内的短按钮文本。必要时直接用上面的文本决策
`拒绝` 作为更稳定的黑盒路径。

本轮还暴露一个 agent 行为风险：提示“在当前工作目录创建 approved.txt”时，Claude 实际写到
了 `/home/glwuy/approved.txt`，而运行信息里的 cwd 是正确的 `/tmp/...`。文件类测试不能只信
agent 文本回复，必须用本地 `ls/cat` 或飞书文件回传结果验证实际路径。

### 完成后的活跃状态必须清理

本轮发现并修复过一个真实状态泄漏：长输出任务 `qa-long-20260523-224830` 已经在日志中
`COMPLETE` / `SENT`，但旧 `/home` 卡片仍显示 `⏳ 执行中`。根因是 provider turn 完成后
`activeControls` 没有清理，`/home` 用它判断话题是否仍在执行。

回归路径：

```bash
npm run live:feishu:send -- "/new claude <local-client-id>"
# 从 topic-sessions.json 取最新 rootMessageId
npm run live:feishu:reply -- --root "$root" "请只回复一行：$marker ok"
# 等日志 COMPLETE / SENT
npm run live:feishu:send -- "/home $marker-check"
```

验收信号：

```text
最近会话话题
1. ✅ 可继续 请只回复一行：...
```

同时旧的 `qa-long-...` 话题在新 `/home` 卡片中也应显示 `✅ 可继续`，不能继续显示
`⏳ 执行中`。

### `/stop` 必须在话题里只发 `/stop`

`/stop` 后面如果跟普通标记文本，代码会把它当成显式 `sessionKey`：

```bash
npm run live:feishu:reply -- --root "$root" "/stop qa-stop-..."
```

这不会中断当前话题任务，常见返回是：

```text
⚠️ 无活跃执行可停止
```

真实用户路径应该是在正在执行的话题内只发送：

```bash
npm run live:feishu:reply -- --root "$root" "/stop"
```

本轮成功信号：

```text
[query] ... ERROR Interrupted
飞书话题显示：⚠️ 已停止
飞书话题显示：⏹ 已中断当前执行
```

### 执行中追加消息按 provider 区分验收

Claude Code 支持执行中插话/排队。可复用测试：

```bash
marker="qa-steer-$(date +%Y%m%d-%H%M%S)"
npm run live:feishu:reply -- --root "$root" \
  "执行中插话测试 $marker。必须使用 Bash 工具执行：python3 -c \"import time; [print('$marker-tick-%02d'%i, flush=True) or time.sleep(1) for i in range(25)]\"。如果执行中收到追加消息，请在最终回复里包含追加消息里的 token。"

sleep 5
npm run live:feishu:reply -- --root "$root" \
  "执行中追加消息 $marker token=qa-steer-inserted。请记住这个 token 并在最终回复中输出。"
```

验收信号：

```text
飞书显示：💬 已插入当前会话
Claude transcript 出现 queued_command
最终回复包含 qa-steer-inserted
```

Codex 当前不支持 native steer/queue。对应负向验收信号是：

```text
⚠️ 当前 provider 不支持执行中插入消息，请等待完成或使用 /stop
```

### 长输出/限频 smoke

长输出测试用于验证真实模型流式输出、卡片更新和飞书前端显示是否稳定。可复用任务：

```bash
marker="qa-long-$(date +%Y%m%d-%H%M%S)"
npm run live:feishu:send -- "/new claude <local-client-id>"
# 从 topic-sessions.json 取最新 rootMessageId

npm run live:feishu:reply -- --root "$root" "/perm off"
npm run live:feishu:reply -- --root "$root" \
  "请只输出 120 行，每行格式为 $marker-line-NNNN（NNNN 从 0001 到 0120）。不能调用工具，不能修改文件。直接输出文本即可。"
```

验收信号：

```text
RECV ... qa-long-...
START session=...
COMPLETE tokens=...+...
SENT msgId=...
```

并检查日志里没有 `230020`、`429`、`Rate limited` 或 query `ERROR`。本轮
`qa-long-20260523-224830` 真实通过：120 行输出约 19 秒完成，日志显示 `COMPLETE`
和 `SENT`，飞书 Web 显示 `✅ 已完成`。注意飞书 Web 可能折叠长文本，浏览器文本尾部
不一定能看到全部 120 行，因此验收要以日志和完成状态为主。

### 文件回传闭环验收

文件修改和文件回传应拆成两个信号验收：

1. 本地文件确实被 agent 写出来。
2. 飞书话题里确实出现 `[文件] result.md`。

可复用任务模板：

```bash
marker="qa-file-$(date +%Y%m%d-%H%M%S)"
dir="/tmp/tlive-live-qa-$marker"
mkdir -p "$dir"
printf 'seed=%s\nsource=live-feishu\n' "$marker" > "$dir/input.txt"

npm run live:feishu:reply -- --latest claude "/cd $dir"
# 等日志出现 CMD /cd

npm run live:feishu:reply -- --latest claude \
  "QA真实文件修改测试 $marker。请在当前工作目录读取 input.txt，创建 result.md，内容必须严格包含三行：marker=$marker、input=<input.txt里的完整内容，把换行用 | 连接>、status=edited-by-agent。写完后调用 MCP 工具 mcp__tlive__tlive_send_file，把 result.md 作为 file/base64 发回当前飞书话题。最后只回复 ${marker}-done。"
```

如果 agent 没有拿到 `routeToken`，可以在任务中显式给 `tlive_send_file` 的
`channelType=feishu`、`chatId`、`replyToMessageId=<rootMessageId>`、`replyInThread=true`。
这适合 live QA，但不要把真实 chat id 写入提交的自动化用例。

本轮成功信号：

```text
result.md 内容包含 marker/input/status 三行
飞书 Web 话题显示 [文件] result.md
```

注意：用 OpenAPI 查询会话历史可能还需要额外用户权限。本轮用用户 token 读取历史返回
`need scope: im:message.p2p_msg:get_as_user`，所以文件回传验收优先用浏览器 UI 或 bot
发送日志，而不是默认依赖消息历史 API。

### 新建会话按钮会污染测试群

`新建 Claude Code` / `新建 Codex` 是真实状态变更，会在飞书里创建新话题。本轮点击
`新建 Codex` 成功触发：

```text
card.action.trigger ... "action":"action:new:codex:vm-0-16-ubuntu"
```

飞书消息区随后出现：

```text
新 Remote Codex 会话
已开启新话题，请在本话题内继续发送消息。
```

这条路径可以作为 P1 验证，但不要在每次 smoke 中默认执行，避免制造过多测试话题。

### 测试产物不要提交

浏览器测试可能留下：

```text
.playwright-mcp/
/tmp/feishu-qa-*.png
```

这些是本地证据，不应提交。结束后检查：

```bash
git status --short
```

## 参考文档

- 飞书获取授权码：<https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code?lang=zh-CN>
- 飞书获取 `user_access_token`：<https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token>
- 飞书发送消息：<https://open.feishu.cn/document/server-docs/im-v1/message/create?lang=zh-CN>
- 飞书接收消息事件：<https://open.feishu.cn/document/server-docs/im-v1/message/events/receive?lang=zh-CN>
