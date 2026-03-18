# TLive

[English](README.md)

终端实时监控 + AI 编码工具 IM 桥接。

两个独立功能，按需使用：
- **`tlive <cmd>`** — 包装任何命令，手机浏览器访问终端
- **`/tlive`** — 从 Telegram、Discord、飞书 与 Claude Code / Codex 双向交互

## 安装

```bash
npm install -g tlive
```

## 功能 1：Web 终端 (`tlive <cmd>`)

包装长时间运行的命令，手机浏览器远程访问。

```bash
tlive claude                  # 包装 Claude Code
tlive python train.py         # 包装训练脚本
tlive npm run build           # 包装构建
```

在 `http://localhost:8080?token=xxx` 打开 Web 终端 — 任何设备都能查看和交互。

多会话共享仪表盘：
```bash
# 终端 1
tlive claude
# 终端 2（自动加入已有 daemon）
tlive npm run dev
```

Daemon 首次 `tlive <cmd>` 时自动启动，空闲 15 分钟自动退出。

## 功能 2：IM 桥接 (`/tlive`)

手机上与 Claude Code 对话。获取流式响应，用按钮审批工具权限。

```bash
# 配置 IM 平台
tlive setup

# 安装到 Claude Code / Codex
tlive install skills --claude
tlive install skills --codex

# 在 Claude Code 中使用：
/tlive                    # 启动 Bridge
/tlive setup              # 重新配置
/tlive stop               # 停止
```

### IM 交互流程

```
你 (Telegram):    "修复 auth.ts 里的登录 bug"

TLive (TG):       🔒 需要权限
                   工具: Edit | 文件: src/auth.ts
                   [允许] [本次全允许] [拒绝]

你:                点击 [允许]

TLive (TG):       ✅ 任务完成
                   已修复 auth.ts，测试通过
                   📊 12.3k/8.1k tok | $0.08 | 2m 34s
```

如果 Web 终端同时在运行，IM 消息会带上链接：
```
🖥 查看终端 → http://localhost:8080/terminal.html?id=abc
```

### 支持平台

| | Telegram | Discord | 飞书 |
|---|----------|---------|------|
| 流式响应 | 编辑消息，700ms | 编辑消息，1500ms | CardKit v2，200ms |
| 权限按钮 | 内联键盘 | Button 组件 | 互动卡片 |
| 图片 | 支持 | 支持 | 支持 |

## 命令

### CLI（Go 二进制）

```bash
tlive <cmd>                # Web 终端
tlive stop                 # 停止 daemon
tlive setup                # 配置
tlive install skills       # 安装到 Claude Code / Codex
```

### Claude Code 技能

```
/tlive                     # 启动 IM Bridge
/tlive setup               # 配置 IM
/tlive stop                # 停止 Bridge
/tlive status              # 查看状态
/tlive doctor              # 诊断
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
TL_DC_BOT_TOKEN=...
TL_FS_APP_ID=...
TL_FS_APP_SECRET=...
```

## 架构

```
┌─ 功能 1: Web 终端 ─────────────────┐    ┌─ 功能 2: IM 桥接 ────────────────┐
│                                     │    │                                  │
│  tlive claude                       │    │  /tlive (Claude Code 技能)       │
│    └── Go 二进制                     │    │    └── Node.js Bridge           │
│        ├── PTY 包装                  │    │        ├── Agent SDK            │
│        ├── Web UI (xterm.js)        │    │        ├── Telegram 适配器       │
│        ├── HTTP API                 │    │        ├── Discord 适配器        │
│        └── WebSocket                │    │        └── 飞书适配器            │
│                                     │    │                                  │
└─────────────────────────────────────┘    └──────────────────────────────────┘
              │                                          │
              └───── Bridge 检测 Go daemon ──────────────┘
                     → IM 消息带 Web 终端链接
```

两个独立组件。Bridge 不依赖 Go Core。Go Core 不依赖 Bridge。

## 开发

```bash
# Go Core
cd core && go build -o tlive ./cmd/tlive/ && go test ./...

# Bridge
cd bridge && npm install && npm run build && npm test
```

## 安全

- 默认绑定 `127.0.0.1`（需要局域网访问显式设置 `--host 0.0.0.0`）
- 自动生成认证 token
- IM Web 链接使用限时令牌（1h，只读）
- IM 用户白名单
- 日志自动脱敏
- 配置文件 `chmod 600`

## 许可证

MIT
