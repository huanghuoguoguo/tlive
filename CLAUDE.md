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
├── core/             # Go Web 终端服务（可选）
├── docs/             # 用户文档
├── SKILL.md          # /tlive skill 定义
└── config.env.example
```

## 开发规则

### 架构
- Bridge (TypeScript) 和 Core (Go) 独立运行，通过 HTTP API 通信
- Bridge 使用 Claude Agent SDK 与 Claude Code 交互
- IM 适配器按需动态加载，减少内存占用

### 代码风格
- 使用 TypeScript，编译目标 ES2022
- 测试框架：Vitest
- 工具函数放在 `bridge/src/utils/`
- 常量放在 `bridge/src/utils/constants.ts`

### 测试
```bash
cd bridge && npm test
```

### 构建
```bash
cd bridge && npm run build
```

### 发布
```bash
# 更新 package.json 版本号
# 创建 tag 和 release
git tag v0.x.x
git push origin main --tags
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