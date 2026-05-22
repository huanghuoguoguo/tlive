# tlive

[![CI](https://github.com/huanghuoguoguo/tlive/actions/workflows/ci.yml/badge.svg)](https://github.com/huanghuoguoguo/tlive/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md)

**在飞书 / Lark 里操控 Claude Code 和 Codex**：从手机发任务，实时看执行进度，并远程管理本地 agent 会话。

## 项目边界

tlive 现在明确只服务一条工作流：

- **IM 通道：** 飞书 / Lark
- **Agent runtime：** Claude Code 和 Codex，通过本地 CLI/SDK runtime 驱动
- **交互方式：** 飞书卡片承载工作台、话题会话、执行进度、问题选择和权限审批

项目不再保留 Telegram、QQ Bot 或通用多通道 runtime 抽象。

## 功能

- 飞书消息直达 Claude Code 或 Codex 会话
- 工作台中创建 Claude/Codex 话题会话、切换目录、恢复历史
- 实时进度卡片：thinking、工具调用、摘要和最终输出
- Claude Code 远程权限审批，支持本会话持续允许
- 支持 provider 能力范围内的 AskUserQuestion 和 deferred tool 交互
- 扫描并恢复 `~/.claude/projects/` 下的 Claude Code 会话，以及 `~/.codex/sessions` 下由 TLive 创建的 Codex 会话
- 文件和图片转发到支持附件的 provider
- Webhook 等自动化入口
- 基于 GitHub Release 的 `tlive upgrade` 自升级

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

执行一次性配置并启动 bridge：

```bash
tlive setup
tlive start
```

然后在飞书 / Lark 中发送 `/tlive` 打开工作台。

如果你希望在 Claude Code 中引导配置，可以先安装 skill，再询问 Claude：

```bash
tlive install skills
claude
```

```text
help me setup tlive
```

配置流程会引导你填写飞书应用凭证、生成本地配置并启动 bridge。

## 架构

```text
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│  飞书/Lark  │────▶│  tlive Bridge    │◀────│ Claude/Codex│
│             │     │  TypeScript      │     │  sessions   │
└─────────────┘     └──────────────────┘     └─────────────┘
```

tlive 本地运行，通过飞书长连接接收消息，再驱动选定的本地 agent provider。Claude Code 通过 `@anthropic-ai/claude-agent-sdk` 接入；Codex 通过 `@openai/codex-sdk` 接入。

## IM 命令

在 agent 话题内直接发送任务：

```text
Fix the login bug in auth.ts
```

公开文本命令刻意保持很少，这样 `/model` 这类 agent 自己的 slash 命令可以透传给 Claude Code 或 Codex。

| 命令 | 说明 |
|------|------|
| `/tlive` | 打开 TLive 工作台 |
| `/home` | 工作台别名 |
| `/stop` | 中断当前执行 |

其它 TLive 操作通过工作台按钮或工作台命令输入完成，包括新建 Claude/Codex 会话、会话历史、目录切换、权限模式、诊断、重启和升级。

## 设置

选择默认 provider：

```env
TL_PROVIDER=claude
# 或
TL_PROVIDER=codex
```

工作台只会显示检测到本地 CLI 的新会话按钮。安装 `claude` 后可创建 Claude Code 会话，安装 `codex` 后可创建 Codex 会话。

Codex runtime 配置：

```env
TL_CODEX_MODEL=
TL_CODEX_PATH=
TL_CODEX_SANDBOX_MODE=workspace-write
TL_CODEX_APPROVAL_POLICY=on-request
TL_CODEX_SKIP_GIT_REPO_CHECK=false
TL_CODEX_REASONING_EFFORT=
TL_CODEX_NETWORK_ACCESS=
TL_CODEX_WEB_SEARCH=
```

Claude Code 设置会按当前会话的工作目录加载：

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

## 升级

升级到最新稳定版：

```bash
tlive upgrade
```

升级到指定版本，包括后续发布的 beta/prerelease 版本：

```bash
tlive upgrade 0.13.7
tlive upgrade 0.13.8-beta.1
```

## 文档

- [完整入门指南](docs/getting-started-cn.md)
- [飞书配置指南](docs/setup-feishu-cn.md)
- [配置说明](docs/configuration-cn.md)
- [故障排查](docs/troubleshooting-cn.md)

## License

MIT
