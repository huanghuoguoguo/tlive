# src/ 架构审查报告

> 审查日期：2026-04-14
> 审查范围：`src/` 全部模块间依赖、内聚/耦合、开闭原则、可维护性

---

## 1. 目录结构

```
src/
├── main.ts               # 入口
├── config.ts             # 配置加载（env 文件 + 环境变量）
├── context.ts            # 全局单例 BridgeContext
├── logger.ts             # 文件 + 控制台日志，含密钥脱敏
├── proxy.ts              # HTTP/SOCKS 代理
├── channels/             # IM 平台适配器
│   ├── base.ts           # BaseChannelAdapter + 工厂注册
│   ├── types.ts          # InboundMessage, RenderedMessage, SendResult
│   ├── errors.ts         # 类型化错误层级
│   ├── index.ts          # 重导出 + 动态加载器
│   ├── feishu/           # 飞书：adapter, formatter, card-builder, markdown, policy, streaming
│   ├── telegram/         # Telegram：adapter, formatter, markdown
│   └── qqbot/            # QQBot：adapter, formatter, markdown, policy
├── engine/               # 核心编排
│   ├── coordinators/     # BridgeManager, QueryOrchestrator, PermissionCoordinator 等
│   ├── commands/         # /new, /help, /status... CommandHandler 模式
│   ├── messages/         # Renderer, TextDispatcher, CallbackDispatcher, Presenter
│   ├── sdk/              # SDKEngine, 权限/问答/延迟工具处理器
│   ├── state/            # SessionState, WorkspaceState, InteractionState
│   ├── utils/            # CostTracker, ToolRegistry, Router 等
│   ├── automation/       # Webhook, Cron 调度
│   └── command-router.ts # 命令注册表接线
├── providers/            # AI 提供商
│   ├── base.ts           # 共享类型定义（StreamChatParams, LiveSession, TurnParams 等）
│   ├── claude-sdk.ts     # Claude Agent SDK 集成
│   ├── claude-live-session.ts  # 长连接会话
│   ├── claude-shared.ts  # 共用工具函数
│   └── session-scanner.ts
├── messages/             # 规范化事件 schema + 适配器
│   ├── schema.ts         # Zod schema，SDK 事件标准化
│   ├── claude-adapter.ts # SDKMessage → CanonicalEvent 映射
│   └── types.ts          # FileAttachment, PermissionRequestHandler, QueryControls
├── permissions/          # 权限网关 + 代理
│   ├── gateway.ts        # PendingPermissions（Promise 等待/解决）
│   └── broker.ts         # PermissionBroker（转发到适配器）
├── formatting/           # 跨平台格式化框架
│   ├── message-formatter.ts  # 抽象类 MessageFormatter<TRendered>
│   ├── message-types.ts      # 20+ 语义数据类型（StatusData, HomeData 等）
│   └── escape.ts
├── ui/                   # UI 抽象
│   ├── types.ts          # Button 类型
│   ├── policy.ts         # ProgressPhase, PermissionDecision 类型
│   ├── channel-policy.ts # ChannelPolicy 接口 + 默认实现
│   └── buttons.ts        # 按钮工厂（locale 感知）
├── delivery/             # 消息分块 + 重试
│   ├── delivery.ts       # chunkMarkdown, DeliveryLayer
│   └── rate-limiter.ts   # ChatRateLimiter
├── store/                # 数据持久化
│   ├── interface.ts      # BridgeStore 接口
│   └── json-file.ts      # JsonFileStore 实现
├── utils/                # 共享工具
│   ├── constants.ts      # CHANNEL_TYPES, CALLBACK_PREFIXES, PLATFORM_LIMITS
│   ├── id.ts, key.ts, string.ts, path.ts, callback.ts, automation.ts, repo.ts
│   └── types.ts          # TodoStatus, EffortLevel
├── i18n/                 # 翻译字典
│   ├── index.ts, en.ts, zh.ts, types.ts
└── markdown/             # Markdown IR + 解析
    ├── ir.ts, index.ts
```

---

## 2. 依赖图

### 分层依赖流向

```
utils, i18n, markdown          ← 叶子层，无内部依赖
store, ui, formatting          ← 依赖 utils
permissions, delivery, messages ← 依赖上面的层
channels                       ← 依赖 formatting, ui, delivery
providers                      ← 依赖 messages, config
engine                         ← 依赖以上所有
main.ts                        ← 顶层入口
```

**无循环依赖。** 依赖方向严格单向。

### 高扇出模块

| 文件 | import 行数 | 说明 |
|------|------------|------|
| `engine/coordinators/bridge-manager.ts` | 32 | "上帝编排器"，接线所有模块。553 行。 |
| `engine/coordinators/query.ts` | 24 | 查询执行管线，但已委托给子处理器 |

### 高扇入模块

| 文件 | 被引用次数 | 说明 |
|------|-----------|------|
| `utils/string.ts` | ~15 | truncate 等工具函数，健康 |
| `channels/base.ts` + `channels/types.ts` | ~12 | 接口类型，健康 |
| `formatting/message-types.ts` | ~10 | FormattableMessage 联合类型，核心契约 |

---

## 3. 内聚性评估

### 高内聚（好）

| 包 | 文件数 | 职责 |
|----|--------|------|
| `permissions/` | 2 | 网关 + 代理，紧凑 |
| `delivery/` | 2 | 分块 + 限流 |
| `store/` | 2 | 接口 + 实现 |
| `ui/` | 4 | 按钮类型、策略接口、按钮工厂 |
| `i18n/` | 4 | 翻译字典 |
| `channels/{platform}/` | 各 4-6 | adapter, formatter, markdown, types, policy，全部围绕同一平台 |
| `engine/commands/` | 各 1 | 每个命令一个文件，单一职责 |
| `engine/sdk/` | 4 | 权限/问答/延迟工具处理器 + SDKEngine |

### 中等

| 包 | 问题 |
|----|------|
| `engine/coordinators/` | 5 个文件各有职责，但 `bridge-manager.ts` 过胖（适配器生命周期 + 消息循环 + 回调路由 + webhook/cron + 单例锁 + 广播） |
| `utils/` | 10 个文件，轻微"杂物抽屉"。`callback.ts`（回调解析）是 UI/engine 关注点，`repo.ts`（git root）是工作区关注点，`automation.ts` 只有一个函数 |

### 有问题

| 包 | 问题 |
|----|------|
| `messages/` | `types.ts` 定义 `FileAttachment`、`PermissionRequestHandler`、`QueryControls` — 这些是 provider 层契约，不是"消息"关注点。同时 `formatting/message-types.ts` 定义 UI 侧消息数据。两个 `types.ts` 同名不同义 |

---

## 4. 耦合评估

### 好的解耦

- **Engine 不知道具体平台**（大部分情况）— 通过 `BaseChannelAdapter` 和 `RenderedMessage` 泛型交互
- **Command 模式**隔离命令 — `CommandHandler` 接口 + `CommandRegistry`，依赖注入 `CommandContext`
- **Formatter 模式**解耦渲染 — `MessageFormatter<TRendered>` 抽象类，平台子类选择性覆写
- **SDK 处理器提取**干净 — 权限、问答、延迟工具各自独立类

### 耦合问题

#### 问题 1：Engine 直接引用飞书类型

```typescript
// engine/coordinators/bridge-manager.ts:3
import type { FeishuRenderedMessage } from '../../channels/feishu/types.js';

// engine/messages/hook-notification.ts:3
import type { FeishuRenderedMessage } from '../../channels/feishu/types.js';
```

广播时 `if (adapter.channelType === 'feishu')` 做特殊处理。每加一个需要特殊广播逻辑的平台都要改 engine。

#### 问题 2：适配器工厂内部调 `loadConfig()`

```typescript
// channels/telegram/adapter.ts:479
registerAdapterFactory('telegram', () => new TelegramAdapter(loadConfig().telegram));
```

配置应由上层（main.ts）注入，不是底层自己拉。依赖方向反了。

#### 问题 3：`RenderedMessage` 是封闭联合类型

```typescript
// channels/types.ts:40-43
export type RenderedMessage =
  | import('./telegram/types.js').TelegramRenderedMessage
  | import('./feishu/types.js').FeishuRenderedMessage
  | import('./qqbot/types.js').QQBotRenderedMessage;
```

加新平台必须改这个 union。engine 里用 `as any` 强转绕过 — 类型设计本身有问题。

#### 问题 4：`classifyError()` 用 if-chain 按平台分支

```typescript
// channels/errors.ts:40-73
if (channel === 'telegram') { ... }
if (channel === 'feishu') { ... }
if (channel === 'qqbot') { ... }
```

应该是 `BaseChannelAdapter` 的虚方法，各平台覆写。

#### 问题 5：两个同名 `FileAttachment` 类型

- `channels/types.ts`：有 `url?` 字段
- `messages/types.ts`：无 `url` 字段

同名不同义，容易 import 错。

#### 问题 6：`channels/index.ts` 静态导出破坏懒加载

```typescript
// 注释说"动态加载减少内存"，但 barrel 文件全量导出了三个平台
export { TelegramFormatter, TelegramAdapter } from './telegram/index.js';
export { FeishuFormatter, FeishuAdapter } from './feishu/index.js';
export { QQBotFormatter, QQBotAdapter } from './qqbot/index.js';
```

---

## 5. 开闭原则

### 满足的部分

| 扩展点 | 方式 | 评价 |
|--------|------|------|
| 新增命令 | 写 `CommandHandler` + 注册 | 不改已有代码 |
| 新增格式化消息类型 | 加 `FormattableMessage` 成员 + `MessageFormatter` 虚方法 | 已有平台继承默认实现 |
| 新增频道策略 | 实现 `ChannelPolicy` 接口 | 不改已有代码 |

### 违反的部分

**加一个新 IM 平台至少要改 6 个文件：**

| 文件 | 改什么 | 是否可避免 |
|------|--------|-----------|
| `channels/types.ts` | 加入 `RenderedMessage` union | 可避免（改用泛型或基类型） |
| `channels/index.ts` | 加静态导出 + 动态 import 路径 | 可避免（纯动态注册） |
| `channels/errors.ts` | `classifyError()` 加 if 分支 | 可避免（改为虚方法） |
| `engine/coordinators/bridge-manager.ts` | 如需特殊广播处理 | 可避免（推入适配器） |
| `engine/messages/hook-notification.ts` | 如需特殊 hook 处理 | 可避免（推入适配器） |
| `config.ts` | 加平台配置段 | 难以避免（各平台配置结构不同） |

前 5 项可以通过将平台特定逻辑推入适配器来消除。

### 其他违反

- `QUICK_COMMANDS` 在 `bridge-manager.ts` 中硬编码为 `Set`，与 `CommandRegistry.getQuickCommands()` 重复。加快捷命令要改两处。

---

## 6. 可维护性

### 优点

- **命名一致**：文件名 = 主导出（`bridge-manager.ts` → `BridgeManager`），导航快
- **类型驱动接口**：`BridgeStore`、`CommandHandler`、`BaseChannelAdapter`、`MessageFormatter`、`ChannelPolicy` 等接口让契约显式化
- **测试结构**：`__tests__/` 镜像 `src/` 子目录
- **渲染状态与逻辑分离**：`MessageRenderer`（收集状态）→ `ProgressContentBuilder`（格式化）→ `QueryExecutionPresenter`（刷新/编辑生命周期）
- **i18n 类型安全**：类型化翻译 key + `t(locale, key)` 函数

### 问题

| 问题 | 位置 | 影响 |
|------|------|------|
| `context.ts` 全局单例挂 `globalThis` | `context.ts:16` | 隐藏依赖，测试困难 |
| 两个 `FileAttachment` 同名不同义 | `channels/types.ts` vs `messages/types.ts` | 容易 import 错 |
| `CommandRouter` 700+ 行含大量 helper 逻辑 | `engine/command-router.ts` | `buildHomePayload()`、`resetSessionContext()` 等应提取 |
| `DeliveryLayer` 类疑似未使用 | `delivery/delivery.ts` | engine 直接用 `chunkMarkdown` 自由函数 |
| 测试目录 `__tests__/platforms/` vs 源码 `channels/` 命名不一致 | `__tests__/platforms/` | 新人困惑 |

---

## 7. 总结评分

| 维度 | 评分 | 说明 |
|------|------|------|
| 依赖方向 | ★★★★☆ | 严格分层，无循环，扇出集中在编排层 |
| 高内聚 | ★★★☆☆ | 大部分包聚焦，`BridgeManager` 过胖，`utils/` 略杂 |
| 低耦合 | ★★☆☆☆ | engine 直接引用飞书类型，适配器自拉配置，封闭 union |
| 开闭原则 | ★★★☆☆ | 命令/格式化好，但加新平台要改 6 个文件 |
| 可维护性 | ★★★☆☆ | 命名好，类型驱动，但同名类型和目录不一致增加认知负担 |

**核心矛盾**：抽象层建了（BaseChannelAdapter、MessageFormatter、ChannelPolicy），但没贯彻到底 — engine 里的飞书特判、封闭 union 类型、自拉配置的工厂，都在绕过自己设计的抽象。

---

## 8. 建议改进方向（按优先级）

### P0：消除 engine → 飞书的直接依赖

在 `BaseChannelAdapter` 上加 `prepareBroadcast(msg)` 虚方法，让平台自己处理差异（如飞书的 `receiveIdType`）。删除 engine 中的 `FeishuRenderedMessage` import。

### P1：配置注入替代自拉

适配器工厂改为接收配置参数，由 `main.ts` 在创建时注入，而非工厂内部调 `loadConfig()`。

### P1：`classifyError()` 改为虚方法

移到 `BaseChannelAdapter.classifyError()`，各平台覆写。

### P2：`RenderedMessage` 类型重构

考虑用基类型 + 平台扩展字段，或泛型参数化，消除封闭 union。

### P2：统一 `FileAttachment` 类型

合并为一个（`channels/types.ts` 的版本是超集），消除同名歧义。

### P3：拆分 `BridgeManager`

将广播、webhook/cron 接线、配对模式等提取为独立协调器。

### P3：`channels/index.ts` 去掉静态导出

保留纯动态加载，静态导出移到 `channels/all.ts` 供测试用。
