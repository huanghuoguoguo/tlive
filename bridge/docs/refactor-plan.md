# 平台抽象重构计划

## 问题分析

当前架构中，上层代码（query-orchestrator, command-router 等）直接判断 `channelType` 来处理平台差异：

```typescript
// 当前（耦合）
if (adapter.channelType === 'feishu') {
  msg.feishuHeader = { template: 'blue', title: '...' }
}
if (adapter.channelType === 'telegram') {
  msg.html = markdownToTelegram(text)
}
```

这违反了**依赖倒置原则**：高层模块不应该依赖低层模块的具体实现。

## 解决方案：Strategy Pattern

### 核心思想

**平台差异下沉到 adapter 层**，adapter 提供统一的格式化接口。

```typescript
// 重构后（解耦）
await adapter.sendFormatted({
  type: 'status',
  data: { healthy: true, channels: ['telegram'] }
})
```

### 新增接口

```typescript
// 语义化的消息类型
type FormattableMessage =
  | { type: 'status'; data: StatusData }
  | { type: 'permission'; data: PermissionData }
  | { type: 'question'; data: QuestionData }
  | { type: 'notification'; data: NotificationData }
  | { type: 'home'; data: HomeData }
  | { type: 'sessions'; data: SessionsData }
  // ... 其他类型

// Adapter 新增方法
abstract class BaseChannelAdapter {
  // 现有方法保持不变
  abstract send(message: OutboundMessage): Promise<SendResult>;

  // 新增：语义化格式化方法
  format(msg: FormattableMessage): OutboundMessage;

  // 新增：格式化并发送
  async sendFormatted(msg: FormattableMessage): Promise<SendResult> {
    return this.send(this.format(msg));
  }
}
```

### 实现策略

1. **BaseChannelAdapter** 提供默认实现（适用于大多数平台）
2. **各 adapter 可覆盖** 特定类型的格式化逻辑
3. **平台特定字段**（feishuHeader, html 等）由 adapter 内部处理

### 迁移步骤

1. 定义 `FormattableMessage` 类型和各消息的数据结构
2. 在 `BaseChannelAdapter` 添加 `format()` 方法
3. 将 `formatting/*.ts` 中的平台判断逻辑移入各 adapter
4. 更新上层代码调用 `sendFormatted()` 替代手动格式化
5. 删除上层代码中的 `channelType === 'xxx'` 判断

### 预期收益

- **新增平台时**：只需实现新 adapter，无需修改上层代码
- **平台特性变更时**：只修改对应 adapter
- **测试时**：可独立测试每个 adapter 的格式化逻辑
- **代码量减少**：消除 36 处 `channelType ===` 判断