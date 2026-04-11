# tlive

[![CI](https://github.com/huanghuoguoguo/tlive/actions/workflows/ci.yml/badge.svg)](https://github.com/huanghuoguoguo/tlive/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **Fork 自 [y49/tlive](https://github.com/y49/tlive)** — 仅支持 Claude 的增强版本。

**在手机上操控 Claude Code** — 从手机给 Claude Code 发任务、收进度、点权限审批。

**中文个人用户默认推荐飞书。** 如果你只想尽快跑通第一条消息，直接走“安装 -> `/tlive setup` -> 选择飞书 -> `/tlive` -> 在飞书里发消息”这条路径即可。

## 与原版的差异

- **移除 Codex 支持** — 仅支持 Claude，精简代码
- **增强会话扫描** — 高效尾部读取（32KB）+ 5秒缓存
- **修复 O(n) 查找** — 直接按 session ID 索引绑定关系
- **新增 `/cd`、`/pwd` 命令** — 按会话切换工作目录
- **改进守护进程** — 按需自动启动，无需手动激活

## 安装

```bash
curl -fsSL https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.sh | bash
```

## 快速开始

这是中文用户最快上手的默认路径：

```bash
# 1. 安装 tlive
curl -fsSL https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.sh | bash

# 2. 在你的项目目录启动 Claude Code
claude

# 3. 运行 setup，默认优先选飞书
/tlive setup

# 4. 启动 bridge
/tlive
```

完成后，你会得到：

- 手机里可以直接给机器人发任务
- Claude Code 执行过程会实时回传到手机
- 需要权限时，你会在手机上收到审批卡片

如果你已经长期使用 Telegram 或 QQ Bot，也可以继续选择这些平台；只是中文个人用户默认推荐飞书。

## 配置成功后会看到什么

当你第一次跑通后，通常会出现这些信号：

- 飞书里的机器人能正常回复你的第一条消息
- Claude Code 在本地开始执行时，手机会持续收到进度更新
- 遇到需要确认的操作时，手机里会出现审批卡片

如果这三类信号都出现了，说明你的默认路径已经完整跑通。

## 跑通后的下一步

第一次成功之后，建议马上做这几件事：

- 在飞书里再发一条真实任务，确认日常工作流可用
- 试一次权限审批，确认手机端可以正常允许或拒绝
- 根据你的习惯调整 `/perm`
- 需要更细配置时，再看 [飞书配置指南](docs/setup-feishu-cn.md) 和 [完整入门指南](docs/getting-started-cn.md)

## 功能

| 功能 | 必需 | 说明 |
|------|------|------|
| **IM 对话** | 是 | 手机发消息 → Claude 执行 → 流式返回结果 |
| **权限审批** | 是 | Claude 需要执行命令时，手机收到审批请求 |
| **Web 终端** | 否 | `tlive <cmd>` 包装任意命令，手机浏览器查看 |

## 平台选择

默认推荐顺序如下：

- **飞书**：中文个人用户默认推荐，不需要公网 IP，也不需要自己部署 webhook
- **Telegram**：如果你已经长期使用 Telegram，这是最自然的备选
- **QQ Bot**：补充选项，适合已有 QQ 生态接入需求的场景

## 架构

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│  Telegram   │     │                  │     │             │
├─────────────┤     │   Bridge (TS)    │     │  ~/.claude  │
│    飞书     │────▶│   IM 适配器      │◀────│   sessions  │
├─────────────┤     │                  │     │             │
│   QQ Bot    │     │                  │     │  (扫描读取) │
└─────────────┘     └──────────────────┘     └─────────────┘
```

**Bridge**：TypeScript 服务，通过扫描 session 文件连接 IM 平台和 Claude Code。内置 `tlive` CLI 提供网页终端功能。

## IM 命令

在 Telegram/飞书/QQ Bot 中直接发送：

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
| `/perm on\|off` | 开关权限提示 |
| `/cd <路径>` | 切换工作目录 |
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
- [飞书配置指南](docs/setup-feishu-cn.md)
- [配置选项](docs/configuration-cn.md)
- [故障排查](docs/troubleshooting-cn.md)

## 许可证

MIT
