# tlive 入门指南

本指南带你从零配置一个飞书 / Lark 到 Claude Code 的桥接服务。

## 前置条件

- Node.js 20+ 和 npm
- 一个可创建自建应用的飞书或 Lark 工作区
- 已安装并登录 Claude Code

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

## 配置飞书

按照 [飞书配置指南](setup-feishu-cn.md) 创建自建应用、启用机器人能力、配置事件订阅并发布应用。

`~/.tlive/config.env` 至少需要：

```env
TL_TOKEN=your-secret-token
TL_FS_APP_ID=cli_xxx
TL_FS_APP_SECRET=xxx
TL_FS_VERIFICATION_TOKEN=
TL_FS_ENCRYPT_KEY=
TL_FS_ALLOWED_USERS=
```

保护配置文件权限：

```bash
chmod 600 ~/.tlive/config.env
```

## MCP 集成

TLive SDK 会话会自动加载内置 HTTP MCP server。由 TLive 启动的 agent 可以回调
TLive 发送文件/图片，同时飞书话题路由和权限仍由 server 统一管理。

## 启动

启动 TLive：

```bash
tlive start
```

然后在飞书 / Lark 里给机器人发任务：

```text
Fix the login bug in auth.ts
```

Claude Code 会在本地执行，并把进度、工具调用、权限审批和最终结果实时回传到飞书。

`tlive start` 会同时启动 server 和一个本地执行 client。只有这台机器不应该执行本地
Claude/Codex turn 时，才使用 `tlive server --standalone`。

## 常用命令

- `/perm on|off`：开关权限审批
- `/stop`：中断当前执行
- `/cd <path>`：切换工作目录
- `/pwd`：查看工作目录

## 故障排查

```bash
tlive logs 50
```

常见问题：

- Bridge 启动失败：检查 `TL_FS_APP_ID`、`TL_FS_APP_SECRET` 和 `TL_TOKEN`。
- 机器人能发消息但按钮无效：检查飞书卡片回调配置。
- 收不到飞书消息：检查事件订阅、应用发布和管理员审批状态。
