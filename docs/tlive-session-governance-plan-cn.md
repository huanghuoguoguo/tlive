# tlive 会话治理和多 Session 体验规划

本文聚焦 `tlive` 的会话治理和多 session 体验，目标是在继续走 Claude Agent SDK / LiveSession 路线的前提下，增强忙时处理、恢复策略、会话切换和长期对话可靠性。

## 背景与目标

`tlive` 当前的多 session 体验已经有一部分做得很好：

- 一个 chat 可以关联 Claude session
- 可以通过 `/sessions` 和 `/session` 切换历史会话
- 可以通过 reply-to-message 定位到某条 progress bubble 对应的 session
- 可以用 SDK 的 `now` / `later` 做 steer / queue

但和 `cc-connect` 相比，当前仍然偏“会话路由器”，还不是“会话治理器”。

本篇目标不是把 `tlive` 改成 CLI 驱动，而是在 SDK 路线上把治理能力补齐。

## 当前 tlive 现状

当前会话模型主要由几部分构成：

- `ChannelBinding` 记录 `sessionId`、`sdkSessionId`、`cwd`
- `SDKEngine` 管理 `LiveSession`
- `activeSessionByChat` 记录 chat 当前活跃 session
- `bubbleToSession` 支持 reply-to-message 精确 steering
- `MessageLoopCoordinator` 在 chat busy 时将消息 steer 或 queue 到 SDK session

当前优势：

- 路由方式贴近 IM 交互
- reply 某条消息即可命中对应 session
- 使用 SDK 原生 priority，设计不重

当前问题：

- busy queue 语义还不够明确
- resume 失败时的兜底策略不够系统
- 长时间空闲后的 session 语义不够清楚
- session 和底层实际上下文错配时，缺少更强的回收策略

## 从 cc-connect 借鉴什么，不借鉴什么

借鉴：

- busy session 队列
- turn 结束后自动接续队列
- resume 失败 fallback 到 fresh session
- mismatch recycle
- idle auto-reset

不借鉴：

- 改成 `claude` CLI 驱动
- 用进程生命周期替代 SDK session 生命周期
- 大而全的 session 管理 API

## 典型问题场景

本篇重点解决以下场景：

### 场景 1：当前任务正在跑，用户继续发消息

期望：

- 系统不要简单拒绝
- 用户要知道消息会怎么处理
- 队列行为要稳定可预期

### 场景 2：用户切到旧 session，但底层仍有其他活跃上下文

期望：

- 不要把消息送进错误上下文
- 必要时主动关闭旧 session

### 场景 3：resume 失败

期望：

- 自动 fresh fallback
- 给用户清晰反馈

### 场景 4：用户长时间未使用后再回来

期望：

- 不要静默复用陈旧上下文
- 应该能自动新建或明确提醒

## 目标能力定义

第一阶段目标：

- 明确 busy queue 规则
- 明确 queue 深度上限
- resume 失败时自动 fresh fallback
- 长时间空闲后自动 reset session
- 提供用户可感知的 IM 反馈

第一阶段不做：

- 跨设备 session 同步
- session 导出 / 导入
- 多 Agent 混合 session
- Web 侧 session 控制台

## 目标状态机建议

建议把每个 chat/session 的状态抽象为：

- `idle`
- `active_turn`
- `queued_followups`
- `stale`
- `resetting`
- `closed`

建议规则：

- `active_turn` 时到来的新消息进入 queue 或 steer
- queue 超限时给出明确拒绝反馈
- `stale` 状态下不直接 resume 老上下文
- `resetting` 期间不允许继续注入

## Busy Queue 设计建议

建议保留现有 SDK `now` / `later` 模型，但补充更明确的治理层：

- 每个 session 维护显式 queue 深度
- 给 queue 设上限
- 队列中的消息在 IM 中有可见反馈
- 当前 turn 结束时，系统自动继续处理下一条

建议用户反馈：

- `已插入当前会话`
- `已排队，当前任务结束后继续处理`
- `排队已满，请稍后再发`

## Resume 策略建议

建议区分三类情况：

1. `sdkSessionId` 存在且恢复成功  
2. `sdkSessionId` 存在但恢复失败  
3. `sdkSessionId` 不存在或已失效

建议行为：

- 情况 1：正常 resume
- 情况 2：自动 fresh fallback，并告知用户旧 session 无法恢复
- 情况 3：直接新建 session

## Mismatch Recycle 建议

虽然 `tlive` 走 SDK，不是 CLI 进程，但仍然存在逻辑错位风险：

- chat 当前 binding 指向 A
- active session registry 或 bubble route 仍然残留 B

建议增加一致性检查：

- 切 session
- 切工作区
- `/new`
- settings scope 改变

这些操作发生后，要主动关闭不再匹配的 SDK session，而不是仅靠惰性清理。

## Idle Auto-Reset 建议

当前 `tlive` 已有 idle prune 思路，但建议把“资源清理”和“会话语义重置”分开。

应区分：

- idle prune：为了回收资源，关闭闲置 `LiveSession`
- idle auto-reset：为了防止上下文陈旧，下一次用户发消息时切到 fresh session

建议：

- idle 超时阈值可配置
- 超时后下一次用户发消息时提示：
  - `长时间未活动，已为你开启新会话`

## IM 交互建议

要保持 IM-first，就必须把会话治理结果表达清楚。

建议在这些地方提供状态反馈：

- `/home`
- `/sessions`
- `/new`
- 自动 reset
- resume fallback
- busy queue

建议突出展示：

- 当前会话
- 当前工作区
- 是否存在排队消息
- 上次活跃时间

## 与工作区治理的关系

本篇和工作区治理强相关，但边界要清楚：

- 本篇负责“会话生命周期”
- 工作区文档负责“目录与工作区状态”

两者交界点：

- 切 workspace 时是否关闭 session
- session 是否绑定 workspace

建议默认：

- sessionKey 必须包含 workspace 维度
- 切到不同 workspace 时关闭旧 session

## 分阶段落地计划

### Phase 1

- busy queue 上限和反馈补齐
- `/new`、切 session、切目录时的 session cleanup 一致化
- resume 失败 fresh fallback

### Phase 2

- idle auto-reset
- `/home` 和 session 状态展示增强
- stale session 识别

### Phase 3

- 更细的 queue 策略
- 更强的用户提示和诊断信息

## 验收标准

- 忙时 follow-up 消息的处理规则清晰且稳定
- session 切换后不会把消息送到错误上下文
- 恢复失败时系统能自动兜底
- 长时间不活跃后，用户回到 IM 时行为可预期
- 全过程不依赖 Web 界面

