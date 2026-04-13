# 故障排查

## 快速诊断

```bash
tlive doctor
```

自动检查常见问题。

## 查看日志

```bash
tlive logs          # 最近 20 行
tlive logs 100      # 最近 100 行
```

日志位置：`~/.tlive/logs/bridge.log`

## 常见问题

### 安装失败

二进制文件下载失败。重新运行安装：

```text
Linux / macOS:
curl -fsSL https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.sh | bash

Windows PowerShell:
powershell -NoProfile -ExecutionPolicy Bypass -Command "$tmp = Join-Path $env:TEMP 'tlive-install.ps1'; Invoke-WebRequest 'https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.ps1' -UseBasicParsing -OutFile $tmp; & $tmp"
```

### Bridge 无法启动

1. 检查配置文件是否存在：
   ```bash
   cat ~/.tlive/config.env
   ```

2. 检查配置文件权限：
   ```bash
   chmod 600 ~/.tlive/config.env
   ```

3. 运行诊断：
   ```bash
   tlive doctor
   ```

### 收不到 IM 消息

**Telegram:**
- 确认 Bot Token 正确
- 确认已向 Bot 发送过消息
- 确认 Chat ID 正确（私聊为用户 ID，群组为群 ID）

**飞书:**
- 确认应用已发布
- 确认有消息接收权限
- 检查白名单配置

**QQ Bot:**
- 确认应用凭证正确
- 检查白名单配置

### 权限审批超时

默认 5 分钟超时，超时后自动拒绝。QQ Bot 请直接回复 `allow` / `deny` / `always`；不要等待按钮。

## 重置

完全重置：

```bash
tlive stop
rm -rf ~/.tlive
tlive setup
tlive install skills
tlive start
```

## 获取帮助

- [GitHub Issues](https://github.com/huanghuoguoguo/tlive/issues)
- [完整文档](getting-started-cn.md)
