# tlive

IM 桥接服务 — 在手机上操控 Claude Code。

## 快速开始

1. Clone 项目
2. 在项目目录启动 Claude Code
3. 说 "帮我配置 tlive" 或 "setup"

Claude Code 会引导你完成所有配置。

## 支持的 IM 平台

| 平台 | 配置时间 | 说明 |
|------|----------|------|
| Telegram | ~2 分钟 | 个人用户首选 |
| Discord | ~5 分钟 | 团队用户 |
| 飞书 | ~15 分钟 | 国内团队 |
| QQ Bot | ~5 分钟 | QQ 用户 |

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
├── docs/             # 文档
├── .claude/
│   └── skills/
│       └── setup.md  # 配置引导 skill
├── SKILL.md          # 主 skill
└── config.env.example
```

## 配置文件

- 用户配置：`~/.tlive/config.env`
- Claude Code 设置：`.claude/settings.local.json`

## 常用命令

在 Claude Code 中：
- `/tlive` — 启动 Bridge 服务（自动运行，无需手动）
- `/tlive status` — 查看状态
- `/tlive logs` — 查看日志
- `/tlive stop` — 停止服务

守护进程（Core，可选）：
- `tlive start` — 启动 Core 后台服务（用于 Web 终端功能）
- `tlive stop` — 停止
- `tlive status` — 查看状态

Bridge 自动运行，无需手动启动。Core 仅用于可选的 Web 终端功能。

在 IM 中：
- 直接发送消息给机器人即可与 Claude 对话
- `/new` — 新对话
- `/sessions` — 列出当前目录的会话
- `/session <n>` — 切换到会话 #n
- `/stop` — 中断执行
- `/perm on|off` — 开关权限提示
- `/cd <path>` — 切换工作目录
- `/bash <cmd>` — 执行 shell 命令
- `/help` — 显示所有命令