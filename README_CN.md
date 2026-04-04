# tlive

[![CI](https://github.com/huanghuoguoguo/tlive/actions/workflows/ci.yml/badge.svg)](https://github.com/huanghuoguoguo/tlive/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **Fork 自 [y49/tlive](https://github.com/y49/tlive)** — 仅支持 Claude 的增强版本。

**在手机上操控 Claude Code** — 从 Telegram、Discord、飞书、QQ Bot 发送任务，实时查看进度，远程审批权限。

## 与原版的差异

- **移除 Codex 支持** — 仅支持 Claude，精简代码
- **增强会话扫描** — 高效尾部读取（32KB）+ 5秒缓存
- **修复 O(n) 查找** — 直接按 session ID 索引绑定关系
- **新增 `/bash`、`/cd`、`/pwd` 命令** — 更多 shell 控制能力
- **改进守护进程** — 按需自动启动，无需手动激活

## 安装

```bash
curl -fsSL https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.sh | bash
```

## 快速开始

```bash
# 1. Clone 项目
git clone https://github.com/huanghuoguoguo/tlive.git
cd tlive

# 2. 在项目目录启动 Claude Code
claude

# 3. 说 "帮我配置 tlive"
# Claude Code 会引导你完成所有配置
```

就这么简单！Claude Code 会帮你：
- 选择 IM 平台（Telegram/Discord/飞书/QQ Bot）
- 获取平台凭证
- 配置 Claude Code 集成
- 启动服务

## 功能

| 功能 | 必需 | 说明 |
|------|------|------|
| **IM 对话** | 是 | 手机发消息 → Claude 执行 → 流式返回结果 |
| **权限审批** | 是 | Claude 需要执行命令时，手机收到审批请求 |
| **Web 终端** | 否 | `tlive <cmd>` 包装任意命令，手机浏览器查看 |

## 架构

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│  Telegram   │     │                  │     │             │
├─────────────┤     │   Bridge (TS)    │     │  ~/.claude  │
│   Discord   │────▶│   IM 适配器      │◀────│   sessions  │
├─────────────┤     │                  │     │             │
│    飞书     │     │   (必需)         │     │  (扫描读取) │
├─────────────┤     └──────────────────┘     └─────────────┘
│   QQ Bot    │
└─────────────┘

┌──────────────────┐
│   Core (Go)      │     可选：`tlive <cmd>` 网页终端
│   (可选)         │     IM 功能不需要此组件
└──────────────────┘
```

**Bridge**（必需）：通过扫描 session 文件连接 IM 平台和 Claude Code。

**Core**（可选）：提供网页终端功能。IM 对话和权限审批不需要此组件。

## IM 命令

在 Telegram/Discord/飞书/QQ Bot 中直接发送：

```
修复 auth.ts 里的登录 bug
```

Claude 会自动执行并返回结果。常用命令：

| 命令 | 说明 |
|------|------|
| `/new` | 新对话 |
| `/sessions` | 列出当前目录的会话 |
| `/session <n>` | 切换到会话 #n |
| `/stop` | 中断执行 |
| `/verbose 0\|1` | 详细度（0=简洁，1=显示工具调用） |
| `/perm on\|off` | 开关权限提示 |
| `/cd <路径>` | 切换工作目录 |
| `/bash <命令>` | 执行 shell 命令 |
| `/help` | 显示所有命令 |

## 设置

Claude Code 设置从会话的工作目录加载，每次对话都会重新读取：

| 优先级 | 来源 | 路径 |
|--------|------|------|
| 低 | `user` | `~/.claude/settings.json` |
| 中 | `project` | `<cwd>/.claude/settings.json` |
| **高** | `local` | `<cwd>/.claude/settings.local.json` |

通过 `TL_CLAUDE_SETTINGS=user,project,local` 配置（顺序=优先级，后面的覆盖前面的）。修改后新对话生效。

## 更多文档

- [完整入门指南](docs/getting-started-cn.md)
- [配置选项](docs/configuration-cn.md)
- [故障排查](docs/troubleshooting-cn.md)

## 许可证

MIT