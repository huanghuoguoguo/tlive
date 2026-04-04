# tlive

[![CI](https://github.com/huanghuoguoguo/tlive/actions/workflows/ci.yml/badge.svg)](https://github.com/huanghuoguoguo/tlive/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[中文文档](README_CN.md)

**在手机上操控 Claude Code** — 从 Telegram、Discord、飞书发送任务，实时查看进度，远程审批权限。

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

在 Telegram/Discord/飞书中直接发送：

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

## 更多文档

- [完整入门指南](docs/getting-started-cn.md)
- [配置选项](docs/configuration-cn.md)
- [故障排查](docs/troubleshooting-cn.md)

## 许可证

MIT