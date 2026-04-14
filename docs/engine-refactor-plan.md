# Engine 架构优化方案

> 目标：提高 `src/engine/` 的内聚性、降低耦合度，使代码更易测试、更易扩展。
> 原则：渐进式重构，每一步都保持测试绿灯，不做大爆炸式重写。

---

## 一、现状诊断

### 1.1 核心问题总结

| 问题 | 严重程度 | 影响范围 |
|------|---------|---------|
| BridgeManager 上帝类（17 个字段、16 个 `new`、10 个纯转发方法） | 高 | 可测试性、可读性 |
| PermissionCoordinator 职责膨胀（12 个 Map、5+ 种关注点） | 高 | 单一职责、可测试性 |
| CommandRouter.buildHomePayload 依赖 8 个组件（90 行） | 中 | 内聚性 |
| QueryOrchestrator.executeQuery 10 个参数 | 中 | 可读性 |
| `src/messages/` 与 `engine/messages/` 命名冲突 | 低 | 开发者体验 |
| `src/utils/` 与 `engine/utils/` 命名冲突 | 低 | 开发者体验 |
| `engine/index.ts` barrel 零消费者（死代码） | 低 | 维护负担 |
| 协调器之间依赖具体类而非接口 | 中 | 可测试性、替换性 |

### 1.2 做得好的部分（不动）

- `commands/` 注册表模式 — 符合开闭原则
- `sdk/` 三个 handler 各管一种回调 — 内聚
- `state/` 纯状态管理 — 无外部依赖
- `automation/` 独立子系统 — 职责清晰
- 无循环依赖 — 分层方向正确（coordinators -> messages/sdk -> state/utils）

### 1.3 测试覆盖现状

| 组件 | 有专属测试? | 备注 |
|------|-----------|------|
| BridgeManager | 有 | 通过 `(manager as any)` 访问内部组件 |
| PermissionCoordinator | 有 | 用真实 gateway + broker |
| QueryOrchestrator | 有 | 所有依赖手动 mock（15+ 方法） |
| CommandRouter | 有 | 12 个位置参数构造 |
| MessageRenderer | 有 | 覆盖最完整（30+ 测试） |
| SDK handlers (3个) | 无 | 仅通过上层集成测试间接覆盖 |
| InteractionState | 无 | 仅通过 mock 间接覆盖 |
| engine/index.ts | 无 | 死代码 |

---

## 二、重构计划

按优先级排列，每个阶段独立成 PR，互不依赖。

### Phase 0: 低风险清理（1 个 PR）

**目标**：消除死代码和命名混淆，零功能变更。

#### 0.1 删除 `engine/index.ts` barrel

全项目零消费者。所有文件都直接 import 深路径。

```
删除: src/engine/index.ts
```

验证：`npm run build && npm test && npm run lint:dead`

#### 0.2 重命名 `src/messages/` -> `src/canonical/`

消除与 `engine/messages/` 的命名冲突。该包定义的是 CanonicalEvent 协议和 Claude SDK 适配器，"canonical" 更准确。

```
src/messages/           -> src/canonical/
  schema.ts               schema.ts        (CanonicalEvent 定义)
  claude-adapter.ts       claude-adapter.ts (SDK -> CanonicalEvent 映射)
  types.ts                types.ts         (SessionMode, FileAttachment 等)
  index.ts                index.ts
```

影响文件（需更新 import 路径）：
- `src/providers/claude-live-session.ts`
- `src/providers/claude-sdk.ts`
- `src/providers/base.ts`
- `src/engine/state/session-state.ts`
- `src/engine/utils/conversation.ts`
- 相关测试文件

验证：`npm run build && npm test`

---

### Phase 1: 拆分 PermissionCoordinator（1-2 个 PR）

**目标**：将 600+ 行、12 个 Map 的 PermissionCoordinator 拆成 3-4 个内聚的类。

#### 当前 PermissionCoordinator 的 5 种关注点

```
PermissionCoordinator (622 行, 12 Maps)
├── SDK 权限等待/解决     → pendingSdkPerms, permissionSnapshotsByChat
├── Hook 去重与回调       → resolvedHookIds, hookPermissionTexts, hookMessages
├── AskUserQuestion 全流程 → hookQuestionData, toggledSelections
├── 文本审批路由          → permissionMessages, latestPermission
└── 动态会话白名单        → allowedToolsBySession, allowedBashPrefixesBySession
```

#### 拆分方案

```
engine/coordinators/
├── permission.ts                 (保留，变成 facade，~100 行)
├── permission/
│   ├── sdk-perm-tracker.ts       (SDK 权限跟踪 + 文本审批)
│   ├── hook-resolver.ts          (Hook 去重 + 回调解决 + 卡片更新)
│   ├── question-resolver.ts      (AskUserQuestion + 多选 toggle)
│   └── session-whitelist.ts      (动态工具白名单)
```

**详细拆分**：

**`sdk-perm-tracker.ts`** (~120 行)
```ts
export class SdkPermTracker {
  // 从 PermissionCoordinator 搬出:
  private pendingSdkPerms: Map<string, string>;
  private permissionSnapshotsByChat: Map<string, PermissionSnapshotState>;
  private permissionMessages: Map<string, {...}>;
  private latestPermission: Map<string, {...}>;

  // 方法:
  setPendingSdkPerm / clearPendingSdkPerm / getPendingSdkPerm
  notePermissionPending / notePermissionResolved / clearPendingPermissionSnapshot
  getPermissionStatus
  parsePermissionText
  tryResolveByText
  findHookPermission / pendingPermissionCount
  trackPermissionMessage
  getLatestPendingQuestion  // 需要检查 questionData -> 注入 QuestionResolver
}
```

**`hook-resolver.ts`** (~100 行)
```ts
export class HookResolver {
  private resolvedHookIds: Map<string, number>;
  private hookPermissionTexts: Map<string, {text, ts}>;
  private hookMessages: Map<string, {sessionId, timestamp}>;

  trackHookMessage / isHookMessage / getHookMessage
  storeHookPermissionText
  isResolved / markResolved
  resolveHookCallback
  resolveHookPermission
  pruneStaleEntries
}
```

**`question-resolver.ts`** (~150 行)
```ts
export class QuestionResolver {
  private hookQuestionData: Map<string, {...}>;
  private toggledSelections: Map<string, Set<number>>;

  storeQuestionData / getQuestionData / hasQuestionData
  toggleMultiSelectOption / getToggledSelections
  resolveAskQuestion / resolveMultiSelect / resolveAskQuestionSkip / resolveAskQuestionWithText
  cleanupQuestion
  pruneStaleEntries
}
```

**`session-whitelist.ts`** (~60 行)
```ts
export class SessionWhitelist {
  private allowedToolsBySession: Map<string, Set<string>>;
  private allowedBashPrefixesBySession: Map<string, Set<string>>;

  isToolAllowed / addAllowedTool / addAllowedBashPrefix
  rememberSessionAllowance / extractBashPrefix
  clearSessionWhitelist
}
```

**`permission.ts`（facade）** (~100 行)
```ts
export class PermissionCoordinator {
  constructor(
    gateway: PendingPermissions,
    broker: PermissionBroker,
  ) {
    this.sdkTracker = new SdkPermTracker(gateway);
    this.hookResolver = new HookResolver();
    this.questionResolver = new QuestionResolver();
    this.whitelist = new SessionWhitelist();
    // broker 保留在 facade 层
  }

  // 公开子组件供需要精细访问的消费者使用
  get sdk(): SdkPermTracker { ... }
  get hooks(): HookResolver { ... }
  get questions(): QuestionResolver { ... }

  // 保留高层便捷方法，内部委托
  startPruning() / stopPruning()  // 调用各子组件的 prune
  handleBrokerCallback()          // 委托 broker
}
```

#### 迁移策略

1. 先创建 4 个新文件，把逻辑搬过去
2. PermissionCoordinator 变成 facade，公开方法签名不变
3. 外部消费者的 import 路径不变（还是 `from './permission.js'`）
4. 逐步让消费者直接使用子组件（可选，后续 PR）

验证：`npm test` — 现有 `permission-coordinator.test.ts` 应全部通过（facade 保持 API 兼容）

---

### Phase 2: 瘦身 BridgeManager（1-2 个 PR）

**目标**：从 17 个字段降到 ~8 个，消除纯转发方法。

#### 2.1 提取 BridgeFactory（组装器）

BridgeManager 的构造函数负责两件事：(1) 创建所有组件 (2) 运行消息循环。拆出工厂：

```ts
// engine/bridge-factory.ts (新文件)
export interface BridgeComponents {
  store: BridgeStore;
  router: ChannelRouter;
  state: SessionStateManager;
  workspace: WorkspaceStateManager;
  permissions: PermissionCoordinator;
  sdkEngine: SDKEngine;
  ingress: IngressCoordinator;
  loop: MessageLoopCoordinator;
  text: TextDispatcher;
  query: QueryOrchestrator;
  commands: CommandRouter;
  notifications: HookNotificationDispatcher;
}

export function createBridgeComponents(config: Config, deps: BridgeManagerDeps): BridgeComponents {
  // 把 BridgeManager 构造函数中 16 个 new 搬到这里
}
```

BridgeManager 简化为：

```ts
export class BridgeManager {
  private components: BridgeComponents;
  private adapters = new Map<string, BaseChannelAdapter>();
  private webhookServer: WebhookServer | null;
  private cronScheduler: CronScheduler | null;

  constructor(deps?: BridgeManagerDeps) {
    const config = deps?.config ?? loadConfig();
    this.components = createBridgeComponents(config, deps ?? getBridgeContext());
    // webhook + cron 初始化...
  }
}
```

**好处**：
- 测试可以直接用 `createBridgeComponents()` 注入 mock，不再需要 `(manager as any)`
- BridgeManager 的职责收窄为"适配器生命周期 + 消息循环"

#### 2.2 消除纯转发方法

当前 BridgeManager 有 10 个纯转发方法（`trackHookMessage` -> `this.permissions.trackHookMessage`）。

**方案**：让调用者直接持有 `PermissionCoordinator` 的引用，而不是通过 BridgeManager 中转。

受影响的调用者（检查谁调用了这些转发方法）：

| 转发方法 | 调用者 | 改为直接访问 |
|---------|--------|------------|
| `trackHookMessage` | `HookNotificationDispatcher` | 构造时注入 permissions |
| `trackPermissionMessage` | 各平台适配器 | 通过 components 访问 |
| `storeHookPermissionText` | 各平台适配器 | 通过 components 访问 |
| `storeQuestionData` | 各平台适配器 | 通过 components 访问 |
| `getBinding` | `WebhookServer` | 直接注入 store |
| `getLastChatId` | `WebhookServer`, `CronScheduler` | 直接注入 ingress |

**注意**：`WebhookServer` 和 `CronScheduler` 目前接收整个 `BridgeManager` 作为 `bridge` 参数。需要改为接收具体依赖或一个精简接口。

```ts
// 为 automation 消费者定义精简接口
export interface AutomationBridge {
  getAdapter(channelType: string): BaseChannelAdapter | undefined;
  getAdapters(): BaseChannelAdapter[];
  getLastChatId(channelType: string): string;
  injectAutomationPrompt(options: {...}): Promise<{ sessionId?: string }>;
  hasActiveSession(channelType: string, chatId: string, workdir?: string): boolean;
  getBinding(channelType: string, chatId: string): Promise<ChannelBinding | null>;
  getBindingBySessionId(sessionId: string): Promise<ChannelBinding | null>;
}
```

这样 `WebhookServer` 和 `CronScheduler` 只依赖 `AutomationBridge` 接口，不再依赖整个 BridgeManager。

---

### Phase 3: 提取 HomePayloadBuilder（1 个 PR）

**目标**：把 `CommandRouter.buildHomePayload`（90 行，依赖 8 个组件）提取为独立类。

```ts
// engine/presenters/home-builder.ts (新文件)
export class HomePayloadBuilder {
  constructor(private deps: {
    store: BridgeStore;
    state: SessionStateManager;
    workspace: WorkspaceStateManager;
    permissions: PermissionCoordinator;
    sdkEngine: SDKEngine;
    activeControls: Map<string, QueryControls>;
    getAdapters: () => Map<string, BaseChannelAdapter>;
    defaultWorkdir: string;
    commandRegistry: CommandRegistry;
  }) {}

  async build(channelType: string, chatId: string): Promise<HomeData> {
    // 搬 buildHomePayload 逻辑
  }
}
```

同时把 `formatSessionDate`、`formatRelativeTime`、`mapScannedSession` 搬到 `engine/utils/session-format.ts`（已有文件，自然归属）。

CommandRouter 简化为：
```ts
export class CommandRouter {
  constructor(
    private homeBuilder: HomePayloadBuilder,
    private services: CommandServices,
  ) {}

  // handle() 不变 — 查注册表 + 分发
  // buildHomePayload 委托给 homeBuilder
}
```

---

### Phase 4: 简化 QueryOrchestrator（1 个 PR）

**目标**：消除 `executeQuery` 的 10 个参数问题。

#### 引入 QueryContext

```ts
// engine/coordinators/query-context.ts (新文件)
export class QueryContext {
  readonly adapter: BaseChannelAdapter;
  readonly msg: InboundMessage;
  readonly binding: ChannelBinding;
  readonly sessionKey: string;
  readonly renderer: MessageRenderer;
  readonly costTracker: CostTracker;
  readonly permissionHandler: SDKPermissionHandler;
  readonly askQuestionHandler: SDKAskQuestionHandler;
  readonly deferredToolHandler: SDKDeferredToolHandler;
  readonly log: LogContext;

  constructor(opts: { ... }) { ... }
}
```

`executeQuery` 简化为：

```ts
// 之前: 10 个参数
private async executeQuery(adapter, msg, binding, sessionKey, renderer, costTracker, sdkPermissionHandler, sdkAskQuestionHandler, sdkDeferredToolHandler, ctx)

// 之后: 1 个参数
private async executeQuery(ctx: QueryContext)
```

`createRendererAndPresenter` 也可以移入 QueryContext 的构造逻辑。

---

### Phase 5: 引入接口层（可选，长期）

**目标**：协调器之间通过接口而非具体类依赖，提高可测试性。

当前只有 `BridgeStore` 和 `LLMProvider` 是真接口，其余 5 个核心组件都是具体类：

```
PermissionCoordinator  (具体类)
SDKEngine              (具体类)
SessionStateManager    (具体类)
ChannelRouter          (具体类)
ConversationEngine     (具体类)
```

**方案**：为每个提取一个窄接口，只包含消费者实际调用的方法。

```ts
// 示例: QueryOrchestrator 实际只用到 SDKEngine 的这些方法
export interface ISessionEngine {
  resolveSessionTarget(...): SessionTarget;
  getOrCreateSession(...): LiveSession;
  setControlsForChat(...): void;
  setActiveMessageId(...): void;
  updateSessionSdkSessionId(...): void;
  resetSessionRuntime(...): void;
  getInteractionState(): InteractionState;
}
```

**优先级低**：TypeScript 的结构化类型系统意味着现在测试中 mock 一个部分对象就能通过类型检查。这一步更多是架构卫生，不是紧迫需求。只在 Phase 1-4 完成后、发现测试仍然难写时才做。

---

## 三、命名冲突修复

### `src/utils/` vs `engine/utils/`

**不改**。两者虽然同名但职责分层明确：`src/utils/` 是项目级纯函数，`engine/utils/` 是 engine 领域工具类。相对路径 `../utils/` vs `./utils/` 在实际代码中不会混淆（TypeScript 编译会捕获错误）。改名的收益不值得大面积路径变更的成本。

### `src/messages/` vs `engine/messages/`

在 Phase 0.2 中已处理（`src/messages/` -> `src/canonical/`）。

---

## 四、实施顺序与依赖关系

```
Phase 0 ─── 低风险清理 (删 barrel、重命名 messages/)
   │
   ├── Phase 1 ─── 拆分 PermissionCoordinator (最高收益)
   │
   ├── Phase 2 ─── 瘦身 BridgeManager (BridgeFactory + 消除转发)
   │
   ├── Phase 3 ─── 提取 HomePayloadBuilder
   │
   └── Phase 4 ─── 简化 QueryOrchestrator (QueryContext)
                       │
                       └── Phase 5 ─── 引入接口层 (可选)
```

Phase 0-4 之间无强依赖，可以并行开发，但建议按编号顺序做——前面的改动会让后面的更容易。

---

## 五、每个 Phase 的验证清单

每个 PR 合并前必须满足：

- [ ] `npm run build` 通过
- [ ] `npm test` 全部通过（604 个测试）
- [ ] `npm run lint:dead` 无新增死代码
- [ ] 现有测试的 mock 结构不需要大面积修改（facade 保持兼容）
- [ ] 不引入新的循环依赖

---

## 六、风险与注意事项

| 风险 | 缓解措施 |
|------|---------|
| PermissionCoordinator 拆分后 facade API 不兼容 | 保持所有公开方法签名不变，facade 只做委托 |
| BridgeManager 改动影响 automation 集成 | 先定义 `AutomationBridge` 接口，WebhookServer/CronScheduler 测试先过 |
| 重命名 `src/messages/` 影响范围较大 | 用 `git mv` + 批量替换，CI 验证 |
| 测试中的 `(manager as any)` 模式 | Phase 2 的 BridgeFactory 自然解决——测试直接构造 components |
| CommandRouter 12 个位置参数 | Phase 3 自然缓解——HomePayloadBuilder 拿走大部分依赖 |

---

## 七、预期效果

| 指标 | 现在 | Phase 4 后 |
|------|------|-----------|
| BridgeManager 字段数 | 17 | ~6 |
| BridgeManager 纯转发方法 | 10 | 0 |
| PermissionCoordinator 行数 | 622 | ~100 (facade) + 4 x ~100 (子组件) |
| PermissionCoordinator Map 数 | 12 (一个类) | 2-4 (每个子组件) |
| CommandRouter 构造参数 | 12 | ~3 |
| QueryOrchestrator.executeQuery 参数 | 10 | 1 (QueryContext) |
| engine/index.ts | 43 行死代码 | 删除 |
| `src/messages/` 命名冲突 | 有 | 无 |
