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
# 1. 配置（交互式引导）
tlive setup

# 2. 注册 Claude Code 集成
tlive install skills

# 3. 启动守护进程
tlive start
```

然后在 Claude Code 中执行 `/tlive`，就可以从手机发消息给 Claude 了。

## 功能

| 功能 | 说明 |
|------|------|
| **IM 对话** | 手机发消息 → Claude 执行 → 流式返回结果 |
| **权限审批** | Claude 需要执行命令时，手机收到审批请求 |
| **Web 终端** | `tlive <cmd>` 包装任意命令，手机浏览器查看 |

## 守护进程

`tlive start` 启动后台服务，开机自启、持续运行。你不需要手动开启 — Claude 需要时自动唤醒。

```bash
tlive start    # 启动守护进程
tlive stop     # 停止
tlive status   # 查看状态
```

## IM 命令

在 Telegram/Discord/飞书/QQ Bot 中直接发送：

```
修复 auth.ts 里的登录 bug
```

Claude 会自动执行并返回结果。常用命令：

| 命令 | 说明 |
|------|------|
| `/new` | 新对话 |
| `/stop` | 中断执行 |
| `/verbose 0\|1` | 详细度（0=简洁，1=显示工具调用） |
| `/perm on\|off` | 开关权限提示 |
| `/cd <路径>` | 切换工作目录 |
| `/bash <命令>` | 执行 shell 命令 |

## 平台配置

| 平台 | 配置时间 | 说明 |
|------|----------|------|
| [Telegram](docs/setup-telegram-cn.md) | ~2 分钟 | 个人用户首选 |
| [Discord](docs/setup-discord-cn.md) | ~5 分钟 | 团队用户 |
| [飞书](docs/setup-feishu-cn.md) | ~15 分钟 | 国内团队 |
| [QQ Bot](docs/setup-qqbot-cn.md) | ~5 分钟 | QQ 用户 |

## Claude Code 配置

tlive 从以下来源读取 Claude Code 设置（通过 `TL_CLAUDE_SETTINGS` 配置）：

| 来源 | 路径 | 用途 |
|------|------|------|
| `user` | `~/.claude/settings.json` | 全局认证和模型 |
| `project` | `.claude/settings.json` | 项目规则、MCP |
| `local` | `.claude/settings.local.json` | 本地覆盖 |

示例 `.claude/settings.local.json`：
```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "你的API密钥",
    "ANTHROPIC_BASE_URL": "https://api.anthropic.com"
  }
}
```

然后在 `~/.tlive/config.env` 中：
```env
TL_CLAUDE_SETTINGS=user,project,local
```

## 更多文档

- [完整入门指南](docs/getting-started-cn.md)
- [配置选项](docs/configuration-cn.md)
- [故障排查](docs/troubleshooting-cn.md)

## 许可证

MIT