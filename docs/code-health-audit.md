# Code Health Audit

> 审计日期: 2026-04-14 | 分支: feat/refactor-home-ui

项目快速迭代中积累的技术债。按优先级分三类，逐步清理。

---

## 工具链优化总结

经优化后，静态检测工具可覆盖更多问题：

| 工具 | 优化内容 | 新检测能力 |
|------|----------|-----------|
| **knip** | 移除 `ignoreExportsUsedInFile: true`（仅保留 type/interface 豁免） | 检测同文件内未使用的 function/const 导出 |
| **jscpd** | 降低阈值 `min-lines: 10 → 5`, `min-tokens: 40` | 检测 5 行以上的文本级重复（之前漏掉 4 行的 formatSize） |
| **lint:patterns** | 新增自定义语义级检测脚本 | 检测 chatKey 构建重复、硬编码路径、内联截断等 |

**当前检测覆盖**：

```
npm run lint:dead        → knip (死代码 + 未使用导出)
npm run lint:duplicate   → jscpd (文本级重复)
npm run lint:patterns    → 自定义脚本 (语义级重复)
npm run lint:entropy     → 综合熵控报告
```

---

## 一、重复代码 / 缺少复用

### 1. `formatSize` 三份相同实现 [高]

`session-format.ts:11` 已导出，但 `status.ts:6` 和 `diagnose.ts:5` 各自复制了一份。

**修复**: 删除 `status.ts` 和 `diagnose.ts` 中的本地副本，改为 `import { formatSize } from '../utils/session-format.js'`。

### 2. `channelType:chatId` key 构建有 5+ 种独立实现 [高]

| 位置 | 方法名 |
|------|--------|
| `session-state.ts:43` | `stateKey()` |
| `workspace-state.ts:42` | `chatKey()` |
| `json-file.ts:22` | `bindingKey()` |
| `engine.ts:171` | `chatKey()` |
| `ingress.ts:173` | `attachmentKey()` |
| `stop.ts:11` | 内联模板字符串 |
| `session.ts:30` | 局部 lambda |

**修复**: 在 `utils/` 中新增 `chatKey(channelType, chatId)` 函数，所有位置统一引用。

### 3. debounced-save 持久化模式重复 [中]

`SessionStateManager` 和 `WorkspaceStateManager` 有几乎相同的 `debouncedSave` + `loadPersisted` / `savePersisted` + `mkdirSync` 模式。

**修复**: 提取 `DebouncedPersister` 基类或 mixin。

### 4. 通知 emoji/template map 4 处重复 [中]

`notification.ts:18`, `message-formatter.ts:242`, `telegram/formatter.ts:39`, `feishu/formatter.ts:541` 各自定义了相同的 `{ stop, idle_prompt, generic }` 映射。

**修复**: 提取为 `utils/constants.ts` 中的共享常量。

### 5. `~` 展开逻辑 3 处重复 [中]

`config.ts:137`, `config.ts:181`, `cd.ts:65` 都有 `path.startsWith('~') ? join(homedir(), path.slice(1)) : path`。`utils/path.ts` 有 `shortPath`（反向操作）但无 `expandTilde`。

**修复**: 在 `utils/path.ts` 中新增 `expandTilde(path)` 函数。

### 6. `join(homedir(), '.tlive')` 硬编码 8+ 处 [中]

已有 `getTliveHome()` 但以下位置未使用: `setup-wizard.ts:11`, `config.ts`, `upgrade.ts`, `claude-shared.ts:57`, `version-checker.ts`, `hooks-state.ts:6`。

**修复**: 统一使用 `getTliveHome()`。

### 7. session ID 截短长度不一致 [低-中]

10+ 文件中截短 session ID，长度有 4/6/8 位，方向有前缀/后缀，无共享工具函数。

**修复**: 在 `utils/` 中新增 `shortId(id, length, direction)` 函数，统一截短规则。

### 8. 内联 truncation 而非使用 `truncate()` [低-中]

`engine.ts:551`, `cron.ts:357`, `notification.ts:38` 手写 `slice + '...'` 而非使用 `utils/string.ts` 的 `truncate()`。

**修复**: 替换为 `truncate()` 调用。

### 9. `shortPath` vs feishu 内联正则 [低]

`feishu/formatter.ts:283` 用 `replace(/^\/home\/[^/]+\//, '~/')` 代替 `shortPath()`，在 macOS 等非标准 home 路径下会失败。

**修复**: 改用 `shortPath()`。

### 10. atomic write 重复实现 [低]

`JsonFileStore` 和 `CronScheduler` (`cron.ts:628`) 各自实现了 write-to-tmp + rename 的原子写入。

**修复**: 提取为 `utils/fs.ts` 中的 `atomicWriteJson()`。

### 11. 进度 phase label map 4 处重复 [低]

telegram/feishu/qqbot/base formatter 各自定义 phase label 映射。

**修复**: 提取为 locale-aware 共享常量。

---

## 二、架构 / 胶水代码

### 1. `PermissionCoordinator` 上帝对象 [高]

621 行，11 个 Map，混合 5+ 职责:
- 权限请求/响应生命周期
- hook 去重
- AskUserQuestion 问答交互（单选/多选/跳过/文本）
- session 白名单管理
- 文本解析

**建议拆分**:
- `SessionWhitelist` — 白名单管理
- `QuestionResolver` — AskUserQuestion 交互
- `PermissionCoordinator` — 仅保留核心权限生命周期

### 2. `SDKEngine` 上帝对象 [高]

885 行，12+ 个 Map。管理 session registry、active controls、bubble mapping、queue depth、interaction state、pruning、diagnostics。

**建议拆分**:
- `SessionRegistry` — session 生命周期
- `MessageRouter` — bubble-to-session 路由
- `QueueManager` — 队列管理

### 3. `BridgeManager` 上帝对象 [高]

553 行，14 个字段。虽已提取 6 个子组件，仍是中心枢纽。`injectAutomationPrompt` 单个方法就是完整的编排流程。

**建议**: 进一步提取 `AutomationOrchestrator`，将 adapter 生命周期管理与消息路由分离。

### 4. `presenter.ts` 前 8 个函数是纯包装 [中]

`presentStatus`, `presentHome` 等函数只做 `{ type, chatId, data }` 包装，零逻辑。

**修复**: 内联到调用方，或改为类型安全的工厂函数。

### 5. `BridgeManager` 单行 delegate 方法 [中]

`bridge-manager.ts:341-357` 有 6+ 个方法只是转发给 `PermissionCoordinator`。

**修复**: 考虑直接暴露 `PermissionCoordinator` 实例，而非逐个包装。

### 6. `SDKEngine.getInteractionState()` 暴露内部状态 [中]

5+ 外部调用点通过 `sdkEngine.getInteractionState()` 直接操作引擎内部的 `InteractionState`。

**修复**: 将外部需要的操作封装为 `SDKEngine` 上的方法。

### 7. 每次 query 创建 3 个一次性 handler 对象 [低-中]

`query.ts:120-153` 每次 query 创建 `SDKPermissionHandler`, `SDKAskQuestionHandler`, `SDKDeferredToolHandler`，无跨调用状态。

**建议**: 改为函数式，或合并为单个 `SDKHandlerContext`。

### 8. `ChannelRouter` 48 行的类 [低]

实质是 `resolve()` 和 `rebind()` 两个工具函数。

### 9. `hooks-state.ts` 是裸模块级函数 [低]

同类关注点（`SessionStateManager`, `WorkspaceStateManager`）都是 class，唯独 hooks 是裸函数操作文件系统，不可测试。

---

## 三、死代码 / 未使用导出

### 1. 旧格式化函数已被类取代 [中]

`formatting/permission.ts` 的 `formatPermissionCard` 和 `formatting/notification.ts` 的 `formatNotification` 已被 `MessageFormatter` 类层次取代，仅测试引用。

**修复**: 删除独立函数，迁移测试到 `MessageFormatter` 路径。

### 2. `formatting/types.ts` 与 `message-types.ts` 类型重复 [中]

`NotificationData` 和 `PermissionCardData` 在 `types.ts` 中有旧版本，`message-types.ts` 中有新版本。

**修复**: 删除 `types.ts` 中的旧类型，统一使用 `message-types.ts`。

### 3. `InteractionState.deferredToolSnapshot()` + `DeferredToolState` 从未调用 [中]

`interaction-state.ts:156` 和 `interaction-state.ts:29`。

**修复**: 删除。

### 4. `StatusData` 中的死字段 [低]

- `StatusData.cwd` — 从未赋值
- `StatusData.sessionId` — 从未赋值
- `StatusData.healthy` — 永远为 `true`

**修复**: 删除这些字段。

### 5. `FormattableMessage` 的 `'projectInfo'` 变体从未构造 [低]

`message-types.ts:415` 定义了类型，`format()` 中有 switch case，但无代码构造此变体。

**修复**: 删除类型变体和对应的 format case。

### 6. `SessionMode.permissionMode` 未使用的分支 [低]

`'acceptEdits'` 和 `'plan'` 从未赋值，仅存在于类型定义中。

**修复**: 从 union 中移除，或标注为 reserved。

### 7. `CHANNEL_TYPES` 常量 + 重复的 `ChannelType` 类型 [低]

`constants.ts:2,8` 定义了 `CHANNEL_TYPES` 对象和派生的 `ChannelType`，但全项目用的是 `channels/types.ts:1` 的版本。`CHANNEL_TYPES` 仅用于 `PLATFORM_LIMITS` 初始化。

**修复**: 删除 `constants.ts` 中的重复类型，`PLATFORM_LIMITS` 直接用字符串字面量。

### 8. 仅测试使用的导出 [低]

- `getToolTitle` (`tool-registry.ts:20`)
- `getToolResultPreview` (`tool-registry.ts:72`)
- `TOOL_RESULT_MAX_LINES` (`tool-registry.ts:14`)
- `parseRequestedUpgradeVersion` (`upgrade.ts:16`)
- `resolveCliPath` (`upgrade.ts:35`)

**修复**: 如果不需要外部使用，移除 `export`。

### 9. `engine/index.ts` barrel 大量未使用的 re-export [低]

`SessionStaleError`, `ConversationEngine`, `CostTracker`, hooks 函数等通过 barrel 导出但无人通过 barrel 导入。

**修复**: 清理 barrel，仅保留实际被间接引用的导出。

---

## Quick Wins（建议优先处理）

1. **`formatSize` 去重** — 改 2 行 import，删 2 个函数
2. **`chatKey()` 统一** — 新增 1 个函数，替换 5+ 处
3. **删除旧格式化函数** — 删 `formatting/permission.ts` + `formatting/notification.ts` + `formatting/types.ts` 中的旧类型
4. **`expandTilde()` 提取** — 新增 1 个函数，替换 3 处
5. **`getTliveHome()` 统一** — 替换 8+ 处硬编码
