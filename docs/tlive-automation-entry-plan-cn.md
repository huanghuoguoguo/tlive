# tlive 自动化入口规划

本文聚焦 `tlive` 的自动化入口设计，目标是在保持 IM-first 的前提下，为外部事件提供一个最小但可靠的接入方式。第一优先级是 webhook，cron 只作为后续选项评估。

## 背景与目标

`tlive` 当前擅长：

- 人在 IM 里直接发任务
- 通过 IM 远程审批
- 通过 IM 观察执行过程

但有一类高价值场景还没有覆盖：

- Git commit 后自动 review
- CI 失败后自动发诊断 prompt
- 文件变化后自动通知 Claude 分析
- 运维脚本触发总结或检查

这类能力不需要 Web 界面，但需要一个事件入口。

## 为什么优先做 Webhook

相比 cron，webhook 更适合 `tlive` 的第一阶段：

- 实现简单
- 安全边界清晰
- 和现有 hook 通知能力天然相关
- 更适合 Git / CI / shell 脚本集成
- 不需要引入调度器和持久 job 生命周期

cron 可以等 webhook 稳定后再做。

## 当前 tlive 现状

当前已有的相关基础：

- 有状态文件和运行时 context
- 有 chat binding / session binding
- 有 hook notification dispatcher
- 有 web terminal 链接能力

当前缺少：

- 正式的外部 HTTP 入口
- 面向 session 的主动 prompt 投递
- 明确的自动化安全模型

## 从 cc-connect 借鉴什么，不借鉴什么

借鉴：

- 外部系统通过 HTTP 把 prompt 投递到指定 session
- token 保护
- prompt 和 exec 分离
- 支持带事件名和附加 payload

不借鉴：

- 过于完整的管理 API 套件
- Web 控制台
- 一上来就做复杂 cron 管理

## 目标能力定义

第一阶段目标：

- 提供一个受 token 保护的 webhook endpoint
- 支持向指定 chat / session 投递 prompt
- 支持附加 event 名称
- 支持附加 JSON payload
- 支持静默和非静默模式

第一阶段建议不做：

- 完整 cron 系统
- 任意 shell exec
- 多租户 webhook
- 复杂 ACL

是否支持 exec：

- 默认建议不支持
- 如果支持，也必须是显式开关，且默认关闭

原因：

- `tlive` 当前主线是 Claude + IM，不是远程 shell 编排器
- prompt 的风险边界更可控

## 请求模型建议

建议最小请求格式：

```json
{
  "target": {
    "channelType": "telegram",
    "chatId": "123456"
  },
  "event": "git:commit",
  "prompt": "Review the latest commit and summarize risk.",
  "payload": {
    "commit": "abc123",
    "branch": "main"
  },
  "silent": false
}
```

也可以支持另一种 session-based 路由：

```json
{
  "sessionId": "session-xxx",
  "event": "ci:failed",
  "prompt": "Analyze the failing build and suggest the smallest fix."
}
```

## 路由策略建议

建议按优先级路由：

1. 显式 `sessionId`
2. 显式 `channelType + chatId`
3. 显式 `projectName` 加默认 chat

第一阶段最好只做前两种，避免过早引入 project 路由复杂度。

推荐规则：

- 指定 `sessionId` 时，投递到该 session
- 指定 `channelType + chatId` 时，走该 chat 当前活跃 session
- 如果没有活跃 session，则可选：
  - 自动创建新 session
  - 或返回错误

建议第一阶段做成可配置策略：

- `reject_if_no_session`
- `create_new_if_no_session`

## IM 反馈建议

自动化入口触发后，用户在 IM 内应该看到明确反馈。

建议文案形态：

- 非静默：显示 `event` 名称和来源
- 静默：仅在结果阶段体现

例如：

- `Git hook: reviewing latest commit`
- `CI failed: analyzing logs`

目标不是做“后台系统”，而是保持 IM 内可感知。

## 安全边界

必须具备：

- Bearer token 或等价 token 校验
- 明确的 enable 开关
- 输入大小限制
- 基本频率限制
- 日志脱敏

建议：

- 默认只允许 `prompt`
- `exec` 必须显式开启
- 对 `payload` 做长度和字段数限制

## 与未来 cron 的关系

cron 建议作为 webhook 之后的第二阶段能力。

原因：

- cron 需要持久 job 存储
- 需要失败处理和重复执行语义
- 需要 session 生命周期规则
- 它会依赖更稳定的 project / session 路由模型

因此本篇只要求在结构上为 cron 预留扩展点，不要求现在实现。

## 分阶段落地计划

### Phase 1

- 增加 webhook endpoint
- token 校验
- prompt 投递
- 非静默 IM 反馈

### Phase 2

- 增加 payload 注入格式
- 增加 session 路由策略配置
- 增加失败观测

### Phase 3

- 评估 cron
- 评估是否开放有限 exec

## 验收标准

- 外部系统可以通过 HTTP 把 prompt 发到指定 chat 或 session
- 用户能在 IM 内看到合理反馈
- 无需引入 Web 管理面
- 默认安全边界清晰
- 不破坏现有人工 IM 使用流程

---

## Phase 3 实现详情

### Cron 调度器

Phase 3 实现了 cron 调度器的基础框架：

**数据结构**：
```typescript
interface CronJob {
  id: string;           // 唯一 ID
  name: string;         // 任务名称
  schedule: string;     // cron 表达式
  channelType?: string; // 目标 channel
  chatId?: string;      // 目标 chat
  projectName?: string; // 项目路由
  prompt: string;       // 发送的 prompt
  event?: string;       // 显示的事件名
  enabled: boolean;     // 是否启用
  lastRun?: number;     // 上次运行时间
  nextRun?: number;     // 下次运行时间
  lastResult?: 'success' | 'failed' | 'skipped';
}
```

**实现要点**：
- 简化的 cron 表达式解析器（支持基本 5 字段格式）
- JSON 文件持久化（`~/.tlive/runtime/cron-jobs.json`）
- 1 分钟间隔的 tick 调度
- 任务失败记录但不自动重试
- 配置开关：`TL_CRON_ENABLED=true` 启用

**配置项**：
```env
TL_CRON_ENABLED=false      # 启用 cron 调度器（默认关闭）
TL_CRON_TIMEZONE=          # 时区（Phase 3 未实现）
TL_CRON_MAX_CONCURRENCY=3  # 最大并发任务数
```

**已知限制**：
- 不支持 cron 范围表达式（如 `1-5`）
- 不支持时区设置
- 实际 prompt 执行依赖 session 路由策略（Phase 4 完善）

### Exec 评估

**安全考量**：

Phase 3 明确决定 **不实现 exec 功能**，原因如下：

1. **安全风险**：
   - 远程执行命令可能被滥用
   - 命令注入风险
   - 系统资源消耗不可控

2. **替代方案**：
   - 使用 prompt 让 Claude 执行任务更安全
   - Claude 有权限审批机制
   - 所有操作在 IM 内可见

3. **如果未来启用 exec**，必须满足：
   - 显式开关（默认关闭）
   - 命令白名单（只允许预定义命令）
   - 超时限制（默认 30 秒）
   - 完整日志记录
   - IM 内反馈（用户可见）

**配置预留**（Phase 3 禁用）：
```env
TL_EXEC_ENABLED=false                  # 禁用（硬编码）
TL_EXEC_ALLOWED_COMMANDS=              # 命令白名单
TL_EXEC_TIMEOUT=30000                  # 超时（毫秒）
TL_EXEC_LOG=true                       # 记录日志
```

### 使用示例

**添加定时任务**（通过代码）：
```typescript
const scheduler = new CronScheduler({ enabled: true, ... });
scheduler.addJob({
  name: 'Daily review',
  schedule: '0 9 * * 1-5',  // 工作日 9am
  channelType: 'telegram',
  chatId: 'your-chat-id',
  prompt: 'Review yesterday\'s commits and summarize progress',
  event: 'daily-review',
  enabled: true,
});
```

**项目路由**：
```typescript
scheduler.addJob({
  name: 'CI failure analysis',
  schedule: '*/5 * * * *',  // 每 5 分钟
  projectName: 'my-project',  // 使用项目默认 chat
  prompt: 'Check CI status and alert if failing',
  event: 'ci-check',
  enabled: true,
});
```

