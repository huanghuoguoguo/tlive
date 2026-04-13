# Troubleshooting

## Quick Diagnostics

```bash
tlive doctor
```

Automatically checks common issues.

## View Logs

```bash
tlive logs          # Last 20 lines
tlive logs 100      # Last 100 lines
```

Log location: `~/.tlive/logs/bridge.log`

## Common Issues

### Installation Failed

Binary download failed. Re-run installation:

```text
Linux / macOS:
curl -fsSL https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.sh | bash

Windows PowerShell:
powershell -NoProfile -ExecutionPolicy Bypass -Command "$tmp = Join-Path $env:TEMP 'tlive-install.ps1'; Invoke-WebRequest 'https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.ps1' -UseBasicParsing -OutFile $tmp; & $tmp"
```

### Bridge Won't Start

1. Check config file exists:
   ```bash
   cat ~/.tlive/config.env
   ```

2. Check file permissions:
   ```bash
   chmod 600 ~/.tlive/config.env
   ```

3. Run diagnostics:
   ```bash
   tlive doctor
   ```

### No IM Messages Received

**Telegram:**
- Verify Bot Token is correct
- Send a message to the bot first
- Verify Chat ID (user ID for DM, group ID for groups)

**Feishu:**
- Verify app is published
- Verify message receive permission
- Check whitelist config

**QQ Bot:**
- Verify app credentials are correct
- Check whitelist config

### Permission Approval Timeout

Default timeout is 5 minutes with auto-deny on timeout. On QQ Bot, reply `allow` / `deny` / `always` directly instead of waiting for buttons.

## Reset

Complete reset:

```bash
tlive stop
rm -rf ~/.tlive
tlive setup
tlive install skills
tlive start
```

## Get Help

- [GitHub Issues](https://github.com/huanghuoguoguo/tlive/issues)
- [Full Documentation](getting-started.md)
