# 架构改进清单

本次审查基于开闭原则（OCP）：新增 channel 不应修改已有代码，只需新增文件。

## 已完成

### 1. config.ts 中的 channel 校验 switch
**问题**：`loadConfig()` 里用 switch 校验每个 channel 的必填字段，和各 adapter 的 `validateConfig()` 完全重复。新增 channel 需要改 config.ts。

**修复**：删除 switch，由 `BridgeManager.start()` 调用 `adapter.validateConfig()` 统一校验。

### 2. platforms/ 与 channels/ 分离
**问题**：接口（`channels/`）和实现（`platforms/`）分在两个顶层目录，但它们是同一个包的抽象与实现。

**修复**：将 `platforms/` 合并到 `channels/` 下，结构变为 `channels/{base,types,errors,telegram/,feishu/,qqbot/}`。

---

## 待改进

### 3. channels/errors.ts — classifyError switch

**优先级**：中 | **工作量**：低

`classifyError(channel, err)` 按 channel 类型 switch 分支处理各 SDK 的错误格式。和 config 校验是同一类 OCP 违反。

**改法**：
- 在 `BaseChannelAdapter` 上加 `classifyError(err: unknown): BridgeError` 方法
- 默认实现处理通用网络错误（ETIMEOUT、ECONNREFUSED 等），fallback 到 `PlatformError`
- 各 adapter override，放入当前 switch 分支的逻辑
- 调用方从 `classifyError('telegram', err)` 改为 `this.classifyError(err)`
- 共享错误类（`BridgeError`、`RateLimitError` 等）保留在 `errors.ts`

### 4. channels/index.ts — loadAdapters 硬编码

**优先级**：低 | **工作量**：极低

`loadAdapters` 用三个 `if (enabledChannels.includes('xxx'))` 加载 adapter。可以改为循环：

```ts
for (const ch of enabledChannels) {
  importPromises.push(import(join(__dirname, 'channels', `${ch}.mjs`)).then(() => {}));
}
```

每个 adapter 的 `.mjs` 已通过 `registerAdapterFactory()` 自注册，循环即可。

### 5. context.ts — globalThis 服务定位器

**优先级**：低 | **工作量**：低

`getBridgeContext()` 通过 `globalThis` 提供全局单例。实际只有 `BridgeManager` 一个生产调用方，且 `main.ts` 已经显式传入了 deps。`getBridgeContext()` 是 fallback 死代码。

**改法**：将 `BridgeManagerDeps` 参数从可选改为必填，删除 `getBridgeContext()` fallback。如果后续没有其他调用方，可以整个删除 `context.ts`。

**暂不处理**：不影响功能，等下次改动 `BridgeManager` 时顺手清理。

---

## 不需要改

| 项目 | 原因 |
|------|------|
| `channels/types.ts` 的 `RenderedMessage` 联合类型 | 纯类型层面，新增 adapter 加一行即可，抽象化（声明合并等）反而增加理解成本 |
| `config.ts` 的 `Config` 接口硬编码各 channel 字段 | 类型安全的配置结构是优点，3 个 adapter 不值得做 `Record<string, unknown>` |
| `channels/index.ts` 的 barrel re-export | 标准便利模式，不构成耦合问题 |
