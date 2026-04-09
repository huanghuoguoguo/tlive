# tlive 开发指南

IM 桥接服务 — 在手机上操控 Claude Code。

## 用户指南

详见 [SKILL.md](./SKILL.md) — 包含完整的命令解析、配置流程、子命令说明。

## 参考文档

- [setup-guides.md](./references/setup-guides.md) — 各平台详细配置步骤
- [token-validation.md](./references/token-validation.md) — 凭证验证命令
- [troubleshooting.md](./references/troubleshooting.md) — 常见问题排查

## 项目结构

```
tlive/
├── bridge/           # TypeScript 桥接服务
│   ├── src/
│   │   ├── channels/ # IM 平台适配器
│   │   ├── providers/# AI 提供商集成
│   │   └── main.ts   # 入口
│   └── package.json
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
- 工具函数放在 `bridge/src/utils/`
- 常量放在 `bridge/src/utils/constants.ts`

### 提交代码
- **main 分支受保护，禁止直接推送**
- **开发新功能或修复 bug 时，必须新建分支**（不要在 main 上直接工作）
  - 功能分支命名：`feat/xxx`
  - 修复分支命名：`fix/xxx`
- 所有代码变更必须通过 Pull Request 合并
- PR 合并方式：Squash merge（自动压缩为单个 commit）

### 测试
```bash
cd bridge && npm test
```

### 构建
```bash
cd bridge && npm run build
```

### 发布
除非开发者指定发布版本，否则不要随便发布版本。
```bash
# 1. 同步更新两个 package.json 的版本号（必须一致）
#    - /package.json（CLI 显示版本，scripts/cli.js 读取）
#    - /bridge/package.json（Bridge 版本检查，version-checker.ts 读取）
# 2. 提交版本号变更
# 3. 合并到 main 后打 tag，release workflow 自动构建并上传 tarball
git tag v0.x.x
git push origin v0.x.x
# 如果需要手动创建 release：
gh release create v0.x.x
```

## 配置文件

- 用户配置：`~/.tlive/config.env`
- 运行时数据：`~/.tlive/runtime/`
- 日志：`~/.tlive/logs/`

## 常用命令

```bash
# 开发
npm run build          # 构建 bridge
npm test               # 运行测试

# 运行
tlive start            # 启动 Bridge
tlive status           # 查看状态
tlive logs             # 查看日志
tlive doctor           # 诊断问题
```