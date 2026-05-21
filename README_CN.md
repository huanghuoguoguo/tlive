# tlive

[![CI](https://github.com/huanghuoguoguo/tlive/actions/workflows/ci.yml/badge.svg)](https://github.com/huanghuoguoguo/tlive/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md)

**在飞书 / Lark 里操控 Claude Code**：从手机发任务，实时看执行进度，并远程审批 Claude Code 权限。

## 项目边界

tlive 现在明确只服务一条工作流：

- **IM 通道：** 飞书 / Lark
- **Agent runtime：** Claude Code，通过 `@anthropic-ai/claude-agent-sdk`
- **交互方式：** 飞书卡片承载进度、问题选择和权限审批

项目不再保留 Telegram、QQ Bot、Codex 或通用 provider/channel runtime 抽象。

## 功能

- 飞书消息直达 Claude Code 会话
- 实时进度卡片：thinking、工具调用、摘要和最终输出
- 手机端远程权限审批，支持本会话持续允许
- 支持 Claude Code 的 AskUserQuestion 和 deferred tool 交互
- 扫描并恢复 `~/.claude/projects/` 下的 Claude Code 会话
- 每个聊天独立工作目录，支持 `/cd`、`/pwd`、`/new`、`/sessions`
- Push、Webhook、Cron 等自动化入口

## 安装

Linux / macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.sh | bash
```

Windows PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "$tmp = Join-Path $env:TEMP 'tlive-install.ps1'; Invoke-WebRequest 'https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.ps1' -UseBasicParsing -OutFile $tmp; & $tmp"
```

验证：

```bash
tlive --help
```

## 快速开始

```bash
git clone https://github.com/huanghuoguoguo/tlive.git
cd tlive
claude
```

然后在 Claude Code 中说：

```text
help me setup tlive
```

Claude Code 会引导你填写飞书应用凭证、生成本地配置并启动 bridge。

## 架构

```text
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│  飞书/Lark  │────▶│  tlive Bridge    │◀────│ Claude Code │
│             │     │  TypeScript      │     │  sessions   │
└─────────────┘     └──────────────────┘     └─────────────┘
```

tlive 本地运行，通过飞书长连接接收消息，再通过 Claude Agent SDK 驱动 Claude Code。

## IM 命令

直接在飞书里发送任务：

```text
Fix the login bug in auth.ts
```

常用命令：

| 命令 | 说明 |
|------|------|
| `/new` | 开启新的 Claude Code 会话 |
| `/sessions` | 列出当前目录下的 Claude Code 会话 |
| `/session <n>` | 切换到某个会话 |
| `/stop` | 中断当前执行 |
| `/perm on\|off` | 开关权限审批 |
| `/cd <path>` | 切换工作目录 |
| `/pwd` | 查看当前工作目录 |
| `/help` | 查看命令 |

## 设置

Agent 设置会按当前会话的工作目录加载：

| 优先级 | 来源 | 路径 |
|--------|------|------|
| 低 | `user` | `~/.claude/settings.json` |
| 中 | `project` | `<cwd>/.claude/settings.json` |
| 高 | `local` | `<cwd>/.claude/settings.local.json` |

配置方式：

```env
TL_AGENT_SETTINGS=user,project,local
```

已有的 `TL_CLAUDE_SETTINGS` 配置仍会作为别名读取。

## 文档

- [完整入门指南](docs/getting-started-cn.md)
- [飞书配置指南](docs/setup-feishu-cn.md)
- [配置说明](docs/configuration-cn.md)
- [故障排查](docs/troubleshooting-cn.md)

## License

MIT
