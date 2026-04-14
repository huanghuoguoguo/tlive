## Context

当前 `src/engine/` 存在多维度架构问题：

| 指标 | 现在 | 目标 |
|------|------|------|
| BridgeManager 字段数 | 17 | ~6 |
| BridgeManager 纯转发方法 | 10 | 0 |
| PermissionCoordinator 行数 | 622 | ~100 (facade) |
| PermissionCoordinator Map 数 | 12 (一个类) | 2-4 (每个子组件) |
| CommandRouter 构造参数 | 12 | ~3 |
| QueryOrchestrator.executeQuery 参数 | 10 | 1 |
| engine → 飞书直接依赖 | 有 | 无 |
| 开闭原则违反 | 加平台改6文件 | 仅加新文件 |

约束：
- 每个 Phase 独立 PR，渐进式重构
- 保持测试绿灯（facade API 兼容）
- 不做大规模重写，每步可回滚

## Goals / Non-Goals

**Goals:**
- 提高 engine 层内聚性、降低耦合度
- 消除开闭原则违反（加新平台不改已有代码）
- 简化测试（直接构造 components，不用 `(manager as any)`）
- 清理死代码和命名冲突

**Non-Goals:**
- 不改变外部 API 或用户功能
- 不引入新的外部依赖
- 不做 Phase 5（引入接口层）— 优先级低，TypeScript 结构化类型已满足测试需求
- 不重构 `src/utils/` vs `engine/utils/` 命名 — 路径区分足够，收益不值得成本

## Decisions

### D1: PermissionCoordinator 拆分策略

**选择**：拆分为 4 个子类 + facade 保持 API 兼容

**方案**：
```
engine/coordinators/
├── permission.ts              (facade, ~100行)
├── permission/
│   ├── sdk-perm-tracker.ts    (SDK 权限 + 文本审批, ~120行)
│   ├── hook-resolver.ts       (Hook 去重 + 回调, ~100行)
│   ├── question-resolver.ts   (AskUserQuestion + 多选, ~150行)
│   └── session-whitelist.ts   (动态工具白名单, ~60行)
```

**备选方案**：
- A) 不拆分，重构内部方法 — 不解决可测试性问题
- B) 完全删除 facade，让消费者直接用子类 — 破坏现有 API，改动面大

**理由**：facade 保持现有测试和消费者不动，内部拆分后每个子类可独立测试。

### D2: BridgeManager 瘦身策略

**选择**：提取 BridgeFactory + 消除转发方法 + 定义 AutomationBridge 接口

**方案**：
```ts
// BridgeFactory: 组装 16 个组件
export function createBridgeComponents(config: Config, deps: BridgeManagerDeps): BridgeComponents

// AutomationBridge: 精简接口供 automation 使用
export interface AutomationBridge {
  getAdapter(channelType: string): BaseChannelAdapter | undefined;
  getAdapters(): BaseChannelAdapter[];
  getLastChatId(channelType: string): string;
  injectAutomationPrompt(options: {...}): Promise<{ sessionId?: string }>;
  hasActiveSession(...): boolean;
  getBinding(...): Promise<ChannelBinding | null>;
}
```

**理由**：
- BridgeFactory 使测试可直接构造 components
- AutomationBridge 让 WebhookServer/CronScheduler 不依赖整个 BridgeManager

### D3: 开闭原则修复策略

**选择**：将平台特定逻辑推入 BaseChannelAdapter 虚方法

**新增虚方法**：
- `prepareBroadcast(msg: RenderedMessage): BroadcastContext` — 处理平台差异（如飞书 receiveIdType）
- `classifyError(err: unknown): BridgeError` — 平台错误分类

**理由**：engine 不再需要 `if (adapter.channelType === 'feishu')` 特判，加新平台只需实现虚方法。

### D4: QueryOrchestrator 参数封装

**选择**：引入 QueryContext 类封装 10 个参数

**方案**：
```ts
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
}
```

**理由**：单个参数对象更易扩展、更易测试，避免参数顺序错误。

## Risks / Trade-offs

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| PermissionCoordinator facade API 不兼容 | 现有测试失败 | 保持所有公开方法签名不变，facade 只做委托 |
| BridgeManager 改动影响 automation 集成 | WebhookServer/CronScheduler 失效 | 先定义 AutomationBridge 接口，确保测试先过 |
| 重命名 `src/messages/` 影响范围大 | 多文件 import 失效 | 用 `git mv` + 批量替换，CI 验证 |
| Phase 0-4 依赖关系处理不当 | 改动顺序冲突 | Phase 0-4 无强依赖，可并行，但建议按顺序做 |

## Migration Plan

**Phase 0（低风险清理）— 1 个 PR**
1. 删除 `src/engine/index.ts`
2. `git mv src/messages src/canonical`
3. 更新 import 路径
4. 验证：`npm run build && npm test`

**Phase 1（拆分 PermissionCoordinator）— 1-2 个 PR**
1. 创建 4 个子类文件
2. PermissionCoordinator 变为 facade
3. 验证：`npm test`（现有测试应全部通过）

**Phase 2（瘦身 BridgeManager）— 1-2 个 PR**
1. 创建 BridgeFactory
2. 定义 AutomationBridge 接口
3. 消除转发方法
4. 验证：automation 测试 + integration 测试

**Phase 3-4（提取组件）— 各 1 个 PR**
1. 创建 HomePayloadBuilder / QueryContext
2. 委托原有逻辑
3. 验证：单元测试

**回滚策略**：每个 Phase 独立 PR，可单独 revert。