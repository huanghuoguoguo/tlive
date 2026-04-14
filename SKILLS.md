# tlive 开发指南

IM 桥接服务 — 在手机上操控 Claude Code。

## 用户指南

详见 [.claude/skills/tlive/SKILL.md](./.claude/skills/tlive/SKILL.md) — 包含完整的命令解析、配置流程、子命令说明。

## 参考文档

- [setup-guides.md](./references/setup-guides.md) — 各平台详细配置步骤
- [token-validation.md](./references/token-validation.md) — 凭证验证命令
- [troubleshooting.md](./references/troubleshooting.md) — 常见问题排查

## 项目结构

```
tlive/
├── src/              # TypeScript 桥接服务源码
│   ├── channels/     # IM 平台适配器
│   ├── providers/    # AI 提供商集成
│   └── main.ts       # 入口
├── scripts/          # CLI 和守护进程脚本
├── dist/             # 构建输出（esbuild）
├── docs/             # 用户文档
├── SKILL.md          # /tlive skill 定义
└── config.env.example
```

## 开发规则

### 架构
- Bridge 使用 Claude Agent SDK 与 Claude Code 交互
- IM 适配器按需动态加载，减少内存占用

### 代码风格
- 使用 TypeScript，编译目标 ES2022
- 测试框架：Vitest
- 工具函数放在 `src/utils/`
- 常量放在 `src/utils/constants.ts`

### 提交代码
- **main 分支受保护，禁止直接推送**
- **开发新功能或修复 bug 时，必须新建分支**（不要在 main 上直接工作）
  - 功能分支命名：`feat/xxx`
  - 修复分支命名：`fix/xxx`
- 所有代码变更必须通过 Pull Request 合并
- PR 合并方式：Squash merge（自动压缩为单个 commit）

### 测试
```bash
npm test               # 运行全部测试（CI 也跑这个）
npm test -- src/__tests__/feishu-progress-card.test.ts  # 单个文件
npm run test:watch     # watch 模式
```

测试分两类：
- **单元/集成测试**（`src/__tests__/`）— 纯函数测试，不需要凭证，CI 可跑。覆盖消息格式化、卡片结构、markdown 转换、权限逻辑等。
- **端到端手动测试** — 需要真实 IM 平台凭证和 Claude Code，只能本地跑。用 `npm start` 启动后在 IM 端发消息验证。

新增功能时至少要写对应的单元/集成测试。涉及飞书卡片的改动，确保 `feishu-progress-card.test.ts` 覆盖了卡片结构正确性（如 `collapsible_panel` 用 `elements` 而非 `body.elements`）。

### 死代码检测
```bash
npm run lint:dead        # 运行 knip 检测未使用的导出/文件
```

使用 [knip](https://github.com/webpro/knip) 从入口点出发做可达性分析，检测：
- 未使用的导出（函数、类、类型）
- 未使用的文件（从 main.ts 不可达）
- 未使用的依赖

**为什么重要**：曾发生过"同一 class 有两份实现"的问题（测试用一份，生产用另一份），导致测试覆盖无法反映实际行为。knip 能在 CI 中自动发现这类问题。

### 构建
```bash
npm run build
```

### 发布
**重要：禁止未经授权发布版本**

- **不要在没有用户明确允许的情况下打 tag 或发布版本**
- 版本发布频率应保持合理，不要因为小改动就频繁发版
- 只有以下情况可以例外发布：
  - Hotfix：修复严重影响用户体验的 bug（如崩溃、安全漏洞）
  - 用户明确要求立即发布
- 正常流程：功能开发 → PR 合并 → 等待用户确认发布时机 → 更新版本号 → 打 tag

```bash
# 1. 更新 package.json 版本号
# 2. 提交版本号变更并通过 PR 合并
# 3. 打 tag，release workflow 自动构建并上传 tarball
git tag v0.x.x
git push origin v0.x.x
# 如果需要手动创建 release：
gh release create v0.x.x
```

## 配置文件

- 用户配置：`~/.tlive/config.env`
- 运行时数据：`~/.tlive/runtime/`
- 日志：`~/.tlive/logs/`

## 日志与排查

### 日志位置
```
~/.tlive/logs/
├── bridge-YYYY-MM-DD.log      # 当日全量日志
├── bridge-YYYY-MM-DD-error.log # 当日错误日志（WARN/ERROR）
```

### 日志格式
每条日志包含时间戳、模块名、级别、消息：
```
2026-04-11T06:17:58Z [feishu] INFO: a1b2c3d4 RECV user=xxx chat=…abcd: hello
```

**关键追踪字段**：
- `rid=xxx` — 8 字符请求 ID，追踪一条消息的完整生命周期
- `chat=…xxxx` — chatId 后 8 位
- `sid=xxxx` — sessionId 后 4 位

### 排查方法

**追踪特定消息**：
```bash
grep "rid=abc123" ~/.tlive/logs/bridge-*.log
```

**查看错误日志**：
```bash
cat ~/.tlive/logs/bridge-*-error.log
```

**实时查看日志**：
```bash
tail -f ~/.tlive/logs/bridge-$(date +%Y-%m-%d).log
```

**查找权限问题**：
```bash
grep "\[perm\]" ~/.tlive/logs/bridge-*.log
```

### 日志模块说明
| 模块 | 职责 |
|------|------|
| `[feishu]` `[qqbot]` `[telegram]` | IM 平台适配器，消息接收/发送 |
| `[bridge]` | 消息分发、命令处理 |
| `[query]` | Claude 查询生命周期 |
| `[perm]` | 权限请求/响应 |
| `[gateway]` | 权限等待队列 |
| `[sdk]` | Claude SDK/LiveSession |

## 常用命令

```bash
# 开发
npm run build          # 构建
npm test               # 运行测试
npm run lint:dead      # 检测死代码（knip）
npm start              # 构建并启动 bridge（开发用，替代 tlive start）
npm run build:watch    # watch 模式自动重编译（不重启进程）
npm run dev            # 热更新模式：编译 + 自动重启（推荐开发时使用）

# 生产（全局安装后）
tlive start            # 启动 Bridge
tlive status           # 查看状态
tlive logs             # 查看日志
tlive doctor           # 诊断问题
```

> **注意**：开发调试时用 `npm run dev`（热更新）或 `npm start`。不要用 `tlive start`，后者启动的是全局安装的版本，不是当前工作区的代码。