## Why

`src/engine/` 存在多个架构问题影响可维护性和可测试性：
- BridgeManager 上帝类（17字段、16个new、10个纯转发方法）
- PermissionCoordinator 职责膨胀（622行、12个Map、5+种关注点）
- engine 直接依赖飞书类型，违反开闭原则（加新平台需改6个文件）
- 存在死代码和命名冲突（messages/ vs engine/messages/）

当前架构评分：低耦合 ★★☆☆☆、开闭原则 ★★★☆☆。需渐进式重构提升质量。

## What Changes

### Phase 0: 低风险清理
- 删除 `src/engine/index.ts` barrel（零消费者，死代码）
- 重命名 `src/messages/` → `src/canonical/`（消除与 `engine/messages/` 命名冲突）

### Phase 1: 拆分 PermissionCoordinator
- 将 622 行、12 个 Map 的 PermissionCoordinator 拆分为 4 个内聚子类：
  - `SdkPermTracker`：SDK 权限跟踪 + 文本审批
  - `HookResolver`：Hook 去重 + 回调解决
  - `QuestionResolver`：AskUserQuestion + 多选 toggle
  - `SessionWhitelist`：动态工具白名单
- PermissionCoordinator 保留为 facade（~100行）

### Phase 2: 瘦身 BridgeManager
- 提取 `BridgeFactory`：组装 16 个组件
- 消除 10 个纯转发方法：让调用者直接持有子组件引用
- 定义 `AutomationBridge` 接口供 WebhookServer/CronScheduler 依赖

### Phase 3: 提取 HomePayloadBuilder
- 将 `CommandRouter.buildHomePayload`（90行，依赖8个组件）提取为独立类
- 迁移相关格式化函数到 `engine/utils/session-format.ts`

### Phase 4: 简化 QueryOrchestrator
- 引入 `QueryContext` 封装 10 个参数
- `executeQuery(adapter, msg, binding, ...)` → `executeQuery(ctx: QueryContext)`

### P0-P1 架构修复
- 消除 engine → 飞书直接依赖：`BaseChannelAdapter` 增加 `prepareBroadcast()` 虚方法
- `classifyError()` 改为 adapter 虚方法
- 配置注入替代 `loadConfig()` 自拉

## Capabilities

### New Capabilities
- `perm-coordinator-refactor`: 拆分 PermissionCoordinator 为可测试子组件
- `bridge-manager-slimming`: 瘦身 BridgeManager，提取 BridgeFactory 和 AutomationBridge 接口
- `query-context`: QueryContext 参数封装简化调用
- `ocp-channel-extensibility`: 开闭原则修复，新平台扩展点

### Modified Capabilities
- `home-payload-builder`: 从 CommandRouter 提取独立组件
- `channel-adapter-interface`: BaseChannelAdapter 增加虚方法（prepareBroadcast, classifyError）

## Impact

### 受影响文件
- `src/engine/coordinators/permission*.ts` - 拆分重构
- `src/engine/coordinators/bridge-manager.ts` - 瘦身
- `src/engine/coordinators/query.ts` - QueryContext 简化
- `src/engine/command-router.ts` - 提取 HomePayloadBuilder
- `src/channels/base.ts` - 增加虚方法
- `src/channels/*/adapter.ts` - 实现新虚方法
- `src/channels/errors.ts` - classifyError 迁移
- `src/messages/` → `src/canonical/` - 重命名

### 测试影响
- 现有 `permission-coordinator.test.ts` 应全部通过（facade 保持 API 兼容）
- BridgeManager 测试可简化（直接构造 components）
- 无需新增端到端测试，单元测试覆盖即可

### 风险缓解
- 每个 Phase 独立 PR，渐进式重构
- facade 保持 API 兼容，不破坏现有消费者
- 每个 PR 必须通过 `npm run build && npm test && npm run lint:dead`