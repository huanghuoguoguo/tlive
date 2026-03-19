# TLive

[English](README.md)

终端实时监控 + AI 编码工具 IM 桥接。

三大功能，按需组合使用：
- **`tlive <cmd>`** — 包装任何命令，手机浏览器访问终端
- **`/tlive`** — 从 Telegram、Discord、飞书与 Claude Code / Codex 双向交互
- **Hook 审批** — 在手机上审批 Claude Code 工具权限

## 安装

```bash
npm install -g tlive
```

## 功能 1：Web 终端

包装长时间运行的命令，手机浏览器远程访问。

```bash
tlive claude                  # 包装 Claude Code
tlive python train.py         # 包装训练脚本
tlive npm run build           # 包装构建
```

```
$ tlive claude --model opus

  TLive Web UI:
    Local:   http://localhost:8080?token=abc123
    Network: http://192.168.1.100:8080?token=abc123
  Session: claude (ID: a1b2c3)
```

多会话共享仪表盘。Daemon 自动启动，空闲 15 分钟自动退出。

## 功能 2：IM 桥接

手机上与 Claude Code 对话。发起新任务，获取实时流式响应和工具可视化。

```bash
tlive setup                   # 配置 IM 平台
tlive install skills --claude  # 安装到 Claude Code

# 在 Claude Code 中：
/tlive                        # 启动 Bridge
```

```
你 (Telegram):    "修复 auth.ts 里的登录 bug"

TLive (TG):       🔍 Grep → 📖 Read → ✏️ Edit → 🖥️ Bash
                   ──────────────────
                   我发现了问题。
                   Token 验证缺少过期检查...

TLive (TG):       ✅ 任务完成
                   已修复 auth.ts，测试通过
                   📊 12.3k/8.1k tok | $0.08 | 2m 34s
```

**详细度控制：** 发送 `/verbose 0|1|2` 切换显示级别（安静/正常/详细）。

## 功能 3：Hook 审批（杀手级功能）

在手机上审批 Claude Code 工具权限。再也不会被 `[y/N]` 提示卡住。

**工作原理：**

```
你在终端正常运行 Claude Code（不需要任何包装）
  │
  ├── Claude 想编辑一个文件
  │   → PreToolUse Hook 触发
  │   → Go Core 接收，挂起请求
  │   → Bridge 轮询，发送到 Telegram：
  │
  │   🔒 需要权限 (本地 Claude Code)
  │   工具: Bash
  │   ┌──────────────────────────┐
  │   │ rm -rf node_modules &&   │
  │   │ npm install              │
  │   └──────────────────────────┘
  │   [✅ 允许]  [❌ 拒绝]
  │
  ├── 你在手机上点 [允许]
  │   → Bridge 解析 → Go Core 返回
  │   → Claude Code 继续执行
  │
  └── 你离开电脑。Claude 继续工作。
      只有需要审批时手机才会响。
```

**配置（一次性）：**

```bash
# 1. 启动 Go Core（接收 hooks）
tlive setup

# 2. 添加 hooks 到 Claude Code 设置
# ~/.claude/settings.json
{
  "hooks": {
    "PreToolUse": [{
      "type": "command",
      "command": "~/.tlive/bin/hook-handler.sh",
      "timeout": 300000
    }],
    "Notification": [{
      "type": "command",
      "command": "~/.tlive/bin/notify-handler.sh",
      "timeout": 5000
    }]
  }
}
```

**安全设计：**
- Hook 脚本先检查 Go Core 是否运行 — 没运行则直接放行（零影响）
- 超时默认**拒绝**（不是允许）— 安全第一
- 审批前显示具体工具名和命令内容
- 适用于任何 Claude Code 会话，不需要包装器

**坐在电脑旁时暂停通知：**

```bash
tlive hooks pause              # 自动放行，不发通知
tlive hooks resume             # 恢复 IM 审批
```

或在手机上发送 `/hooks pause` 或 `/hooks resume`。

## 三个功能的关系

```
┌─ 功能 1: Web 终端 ─────────────┐
│ tlive claude                    │
│ → PTY + Web UI + QR 码          │
│ 访问方式：浏览器                  │
└─────────────────────────────────┘

┌─ 功能 2: IM 桥接 ──────────────┐
│ /tlive (Claude Code 技能)       │
│ → Agent SDK + Telegram/Discord  │
│ → 手机发起新任务                  │
│ 访问方式：IM 应用                 │
└─────────────────────────────────┘

┌─ 功能 3: Hook 审批 ────────────┐
│ Claude Code hooks → Go Core     │
│ → Bridge 轮询 → IM 按钮         │
│ → 审批已有任务                    │
│ 访问方式：IM 应用                 │
└─────────────────────────────────┘

功能 2 和 3 需要 Go Core 运行。
Bridge 检测到 Go Core → IM 消息带 Web 终端链接。
每个功能独立工作。
```

## 支持平台

| | Telegram | Discord | 飞书 |
|---|----------|---------|------|
| IM 桥接（功能 2） | ✅ | ✅ | ✅ |
| Hook 审批（功能 3） | ✅ | ✅ | ✅ |
| 流式响应 | 编辑消息 | 编辑消息 | CardKit v2 |
| 工具可视化 | ✅ | ✅ | ✅ |
| 输入状态 | ✅ | ✅ | — |
| 权限按钮 | 内联键盘 | Button 组件 | 互动卡片 |

## 命令

### CLI

```bash
tlive <cmd>                # Web 终端（功能 1）
tlive stop                 # 停止 daemon
tlive setup                # 配置 IM 平台
tlive install skills       # 安装到 Claude Code / Codex
tlive hooks                # 查看 Hook 状态
tlive hooks pause           # 暂停 Hook（自动放行）
tlive hooks resume          # 恢复 Hook（IM 审批）
```

### Claude Code 技能

```
/tlive                     # 启动 IM Bridge（功能 2）
/tlive setup               # 配置 IM
/tlive stop                # 停止 Bridge
/tlive status              # 查看状态
/tlive doctor              # 诊断

/verbose 0|1|2             # 设置详细度（安静/正常/详细）
/new                       # 开始新对话
/hooks pause|resume        # 切换 Hook 审批
```

## 配置

统一配置文件 `~/.tlive/config.env`（由 `tlive setup` 创建）：

```env
TL_PORT=8080
TL_TOKEN=自动生成
TL_HOST=127.0.0.1
TL_PUBLIC_URL=https://example.com

TL_ENABLED_CHANNELS=telegram,discord
TL_TG_BOT_TOKEN=...
TL_TG_CHAT_ID=...
TL_TG_ALLOWED_USERS=...
TL_DC_BOT_TOKEN=...
TL_FS_APP_ID=...
TL_FS_APP_SECRET=...
```

## 架构

```
                    ┌──────────────────────┐
                    │   Claude Code (本地)  │
                    │                      │
                    │  PreToolUse Hook ────────────┐
                    │  Notification Hook ──────────┤
                    └──────────────────────┘       │
                                                   ▼
┌─ Go Core (tlive) ───────────────────────────────────────────┐
│                                                              │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────────────┐│
│  │ PTY 管理  │  │ Web UI      │  │ Hook 管理器            ││
│  │ (包装    │  │ (仪表盘 +   │  │ (接收 hooks,           ││
│  │  命令)   │  │  xterm.js)   │  │  长轮询, 解析)         ││
│  └──────────┘  └──────────────┘  └────────────────────────┘│
│                                                              │
│  HTTP API + WebSocket                                        │
└──────────────────────────┬───────────────────────────────────┘
                           │ Bridge 轮询 /api/hooks/pending
                           ▼
┌─ Node.js Bridge ────────────────────────────────────────────┐
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐ │
│  │ Agent SDK   │  │ Telegram     │  │ Hook 轮询          │ │
│  │ (IM 发起   │  │ Discord      │  │ (转发到 IM,        │ │
│  │  新任务)    │  │ 飞书         │  │  点击后解析)        │ │
│  └─────────────┘  └──────────────┘  └────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │  你的手机     │
                    │  (IM 应用)   │
                    └──────────────┘
```

## 开发

```bash
# Go Core
cd core && go build -o tlive ./cmd/tlive/ && go test ./...

# Bridge
cd bridge && npm install && npm run build && npm test
```

### 项目结构

```
tlive/
├── SKILL.md                # Claude Code / Codex 技能
├── config.env.example
├── core/                   # Go → tlive 二进制
│   ├── cmd/tlive/          # CLI（Web 终端、停止、配置、安装）
│   ├── internal/
│   │   ├── daemon/         # HTTP 服务器、会话、Hook 管理器
│   │   ├── server/         # WebSocket 处理
│   │   ├── session/        # 会话状态 + 输出缓冲
│   │   ├── hub/            # 广播中心
│   │   └── pty/            # PTY（Unix + Windows ConPTY）
│   └── web/                # 内嵌 Web UI
├── bridge/                 # Node.js → Bridge 守护进程
│   └── src/
│       ├── providers/      # Claude Agent SDK
│       ├── channels/       # Telegram、Discord、飞书适配器
│       ├── engine/         # 对话引擎、Bridge 管理器、流式控制
│       ├── permissions/    # 权限网关 + 代理
│       ├── delivery/       # 分块、重试、限速
│       └── markdown/       # 各平台渲染
├── scripts/
│   ├── hook-handler.sh     # PreToolUse hook → Go Core
│   ├── notify-handler.sh   # Notification hook → Go Core
│   ├── daemon.sh           # Bridge 进程管理
│   └── statusline.sh       # Claude Code 状态行
├── package.json            # npm: tlive
└── docker-compose.yml
```

## 安全

- 默认绑定 `127.0.0.1`（需要局域网访问显式设置 `--host 0.0.0.0`）
- 自动生成认证 token
- Hook 超时默认**拒绝**（不是允许）
- IM 用户白名单
- 日志自动脱敏
- 配置文件 `chmod 600`
- Claude CLI 子进程环境隔离

## 许可证

MIT
