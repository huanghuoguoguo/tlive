---
name: tlive-troubleshoot
description: Troubleshoot tlive IM bridge issues using logs. TRIGGER when: user reports message not received, bot not responding, permission stuck, connection issues, or asks to diagnose tlive problems. Also use when user says "check logs", "what happened", "why didn't it work" in context of tlive/IM bot. When user says "出了问题" or "帮我提 issue", collect diagnostics to generate issue report.
---

# TLive Troubleshoot

Help diagnose tlive IM bridge issues by reading and analyzing logs.

## Quick Commands

**System diagnostics**:
```
/doctor      # OS, Node version, tlive version, config status, channel health
```

## Issue Report Generation

When user says "出了问题" or "帮我提 issue" or "想报告bug":

1. **Collect diagnostics**: Run `/doctor` and read recent logs from `~/.tlive/logs/bridge-{date}.log`
2. **Generate report**: Create markdown content following GitHub issue template:

```markdown
**Describe the bug**
<User's description>

**Environment**
- OS: <from /doctor>
- Node.js version: <from /doctor>
- tlive version: <from /doctor>
- IM Platform: <Telegram/Feishu/QQ>

**Logs**
<last 50 lines from log file>
```

3. **Output to user**: Send formatted report in code block for easy copying

## Log Format

Each log line:
```
2026-04-11T06:17:58Z [module] LEVEL: rid=xxx chat=…xxxx message
```

**Key tracking fields**:
- `rid=xxx` — 8-char request ID, traces one message's full lifecycle
- `chat=…xxxx` — chatId last 8 chars
- `sid=xxxx` — sessionId last 4 chars

## Common Diagnoses

### Message not received

1. Check if message arrived:
```bash
grep "RECV" ~/.tlive/logs/bridge-*.log | grep "user=<userId>"
```

2. If found, trace with requestId:
```bash
grep "rid=<requestId>" ~/.tlive/logs/bridge-*.log
```

3. Look for errors in that trace:
```bash
grep "rid=<requestId>" ~/.tlive/logs/bridge-*-error.log
```

### Permission stuck

```bash
grep "\[perm\]" ~/.tlive/logs/bridge-*.log | tail -50
```

Look for:
- `REQUEST` — permission asked
- `RESOLVED` — user responded
- `TIMEOUT` — no response in 5 min

### Session issues

```bash
grep "\[query\]" ~/.tlive/logs/bridge-*.log | grep "SESSION"
```

- `SESSION_EXPIRED` — session rotated, previous context lost
- `SESSION_STALE` — Claude SDK session invalid

### Connection errors

```bash
grep -E "(WebSocket|connected|closed|error)" ~/.tlive/logs/bridge-*.log | tail -30
```

## Module Reference

| Module | Responsibility |
|--------|----------------|
| `[feishu]` `[qqbot]` `[telegram]` | IM adapter, message receive/send |
| `[bridge]` | Message routing, command handling |
| `[query]` | Claude query lifecycle (START/COMPLETE/ERROR) |
| `[perm]` | Permission request/response |
| `[gateway]` | Permission wait queue |
| `[sdk]` | Claude SDK/LiveSession |
| `[global]` | Unhandled exception/rejection |

## Typical Log Flow

Successful message processing:
```
[feishu] a1b2c3d4 RECV user=xxx chat=…abcd: hello
[query] a1b2c3d4 START session=ef12 cwd=~/proj
[query] a1b2c3d4 COMPLETE tokens=100+200 cost=0.0012$
[query] a1b2c3d4 SENT msgId=msg_5678
```

Permission flow:
```
[perm] a1b2c3d4 REQUEST Bash permId=3456
[perm] a1b2c3d4 RESOLVED Bash permId=3456 → allow
```

Error flow:
```
[query] a1b2c3d4 ERROR <error message>
[query] a1b2c3d4 FATAL <stack trace>
[global] Unhandled rejection: <error>
```

## Tips

1. **Always start with requestId** — if user mentions "my message at 3pm", find the RECV line first
2. **Error logs are separate** — `*-error.log` only has WARN/ERROR, easier to scan
3. **Live tail during testing** — `tail -f ~/.tlive/logs/bridge-$(date +%Y-%m-%d).log`
4. **Check status first** — `/status` shows running channels and PID