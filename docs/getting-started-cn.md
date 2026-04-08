# tlive 入门指南

本指南将带你从零开始配置 tlive。完成后，你可以在手机上监控终端会话、通过 IM 与 Claude Code 对话，以及远程审批权限请求。

如果你是中文环境下的个人用户，默认推荐直接选择飞书。你不需要先比较所有平台，再决定怎么开始。

## 前置条件

- **Node.js 20+** 和 npm
- 以下 IM 平台至少其一：**飞书**、**Telegram** 或 **Discord**（IM Bridge 和 Hook 审批功能需要）
- 已安装 **Claude Code**（IM Bridge 和 Hook 审批功能需要）
- **Web Terminal（网页终端）** 功能可独立使用，不需要 IM 平台

## 安装

```bash
curl -fsSL https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.sh | bash
```

验证安装：

```bash
tlive --help
```

**安装过程说明：** 这个 fork 没有发布到 npm。上面的安装脚本会从 GitHub Release 下载当前版本；如果安装时遇到二进制下载问题，请重新运行同一条 `curl ... | bash` 命令，或按仓库 README 的源码构建方式安装。

## 选择 IM 平台

你可以同时启用多个平台，但首次配置时不建议把选择压力留给自己。

默认建议如下：

| 平台 | 推荐级别 | 适合场景 |
|------|-----------|---------|
| **飞书** | 默认推荐 | 中文个人用户最顺手；使用长连接，不需要公网 IP 或自建 webhook |
| **Telegram** | 备选 | 你已经长期使用 Telegram，希望最快创建机器人 |
| **Discord** | 备选 | 团队已经在用 Discord，且你有服务器管理权限 |

各平台详细配置指南：

- [飞书配置](setup-feishu-cn.md)
- [Telegram 配置](setup-telegram-cn.md)
- [Discord 配置](setup-discord-cn.md)

## 配置

选择你喜欢的方式。

### 方案 A：AI 引导配置（推荐）

在 Claude Code 中运行：

```
/tlive setup
```

AI 会一步步引导你完成配置。对中文个人用户，默认就按飞书这条路径走即可。

### 方案 B：命令行引导

```bash
tlive setup
```

通过交互式命令行引导你选择平台并填写凭证。如果你已经准备好了 bot token，这种方式最快。

### 方案 C：手动配置

直接编辑 `~/.tlive/config.env`。参考 [config.env.example](../config.env.example) 查看所有可用选项。

关键配置项：

```env
# 启用的平台（逗号分隔）
TL_ENABLED_CHANNELS=feishu

# Feishu 示例
TL_FS_APP_ID=cli_xxxxxxxxxxxxxxxx
TL_FS_APP_SECRET=your-app-secret

# Web 终端端口和访问令牌
TL_PORT=8080
TL_TOKEN=your-secret-token
```

记得保护配置文件的权限：

```bash
chmod 600 ~/.tlive/config.env
```

## 安装 Claude Code 集成

```bash
tlive install skills
```

这个命令会注册：

- Claude Code 的 `/tlive` 技能
- 权限审批 hook 脚本（`PreToolUse`、`Notification`）
- 任务完成通知处理器

## 试一试

### 功能一：IM Bridge

在 Claude Code 中启动 Bridge：

```
/tlive
```

如果你按默认路径选择了飞书，现在就去飞书里给机器人发一条私聊消息，例如：

```
帮我看一下当前仓库里有哪些未提交改动
```

Claude Code 会接收消息、处理任务，并将响应实时回传到你的手机上。

使用 `/verbose 0|1` 控制消息的详细程度：
- `0` — 仅显示最终结果
- `1` — 终端卡片，显示工具调用 + 结果（默认）

看到以下结果就说明你已经跑通了：

- 机器人能正常回复你的消息
- Claude Code 的执行进度会持续回传
- 需要权限时，你会收到审批卡片

其他常用命令：`/perm on|off`（权限提示）、`/effort low|high|max`（思考深度）、`/stop`（中断执行）。

第一次跑通后，建议立刻再做三件事：

- 发一条你真实会用到的任务，确认不是只有示例消息能工作
- 主动触发一次需要审批的操作，确认手机端卡片能正常点击
- 用 `/verbose 0|1` 调成你更习惯的消息密度

### 功能二：Hook 审批

这个功能不需要额外操作——正常使用 Claude Code 就行。当 Claude 需要权限执行某个工具（比如运行 bash 命令）时，你的手机会收到一条通知，带有**允许**和**拒绝**按钮。点击即可响应，Claude 继续工作。

超时未响应时默认操作是**拒绝**，安全第一。

### 功能三：Web 终端

用 `tlive` 包装任意命令，即可获得网页终端：

```bash
tlive echo "Hello from tlive!"
```

打开输出中显示的 URL，你会看到一个实时网页终端。试试实际的工作场景：

```bash
tlive claude --model opus
```

你会得到一个本地 URL 和一个局域网 URL。在手机上打开局域网 URL 就能远程监控会话。

## 故障排除

**运行自动诊断：**

```bash
tlive doctor
```

**查看日志：**

```bash
tlive logs 50
```

**常见问题：**

- **"Go Core not found"** — 二进制文件下载不完整，重新运行安装脚本：`curl -fsSL https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.sh | bash`
- **"Bridge not starting"** — 检查 `~/.tlive/config.env` 是否存在且凭证有效。运行 `tlive doctor` 查看详情。
- **"No IM messages"** — 确认 bot token 正确，且机器人已加入正确的对话。参考上方各平台的配置指南进行排查。
- **Hook 没有触发** — 确保已运行 `tlive install skills`。用 `tlive hooks` 查看当前 hook 状态。

## 下一步

- **调整详细程度：** `/verbose 1` 显示终端卡片，包含工具调用和结果
- **在电脑前时暂停 hook：** `tlive hooks pause` 自动放行所有请求，不再打扰。`tlive hooks resume` 恢复 IM 审批。
- **手机访问 Web 终端：** 扫描二维码或使用启动会话时打印的局域网 URL
- **多会话支持：** 同时运行多个 `tlive <cmd>`，所有会话集中在一个面板中
- 阅读完整的 [中文文档](../README_CN.md) 了解所有命令和架构详情
- 如果你刚才走的是默认路径，下一步建议直接看 [飞书配置指南](setup-feishu-cn.md) 做精细化配置
- 如果你还没做过权限审批验证，建议现在就触发一次，确认手机端审批链路是通的
