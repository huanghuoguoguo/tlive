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

**"Go Core not found"**

二进制文件下载失败。重新运行安装：

```bash
curl -fsSL https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.sh | bash
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

### Hook 不生效

1. 确认已安装技能：
   ```bash
   tlive install skills
   ```

2. 检查 Hook 状态：
   ```bash
   tlive hooks
   ```

3. 确认 Bridge 正在运行：
   ```bash
   tlive status
   ```

### 权限审批超时

默认 5 分钟超时，超时后自动拒绝。可以在手机上点击按钮响应，或者回复 `allow`/`deny`。

### Web 终端无法访问

1. 检查端口是否被占用：
   ```bash
   lsof -i :8080
   ```

2. 检查防火墙设置

3. 手机访问时确认在同一局域网，或配置了内网穿透

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