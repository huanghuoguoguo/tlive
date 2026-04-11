---
name: tlive-troubleshoot
description: Troubleshoot tlive IM bridge issues using logs. TRIGGER when: user reports message not received, bot not responding, permission stuck, connection issues, or asks to diagnose tlive problems. Also use when user says "check logs", "what happened", "why didn't it work" in context of tlive/IM bot.
---

# TLive Troubleshoot

Help diagnose tlive IM bridge issues by reading and analyzing logs.

## Quick Start

**Read today's logs**:
```bash
tail -100 ~/.tlive/logs/bridge-$(date +%Y-%m-%d).log
```

**Read error logs**:
```bash
cat ~/.tlive/logs/bridge-*-error.log
```

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
```

## Tips

1. **Always start with requestId** — if user mentions "my message at 3pm", find the RECV line first
2. **Error logs are separate** — `*-error.log` only has WARN/ERROR, easier to scan
3. **Live tail during testing** — `tail -f ~/.tlive/logs/bridge-$(date +%Y-%m-%d).log`
4. **Check status first** — `tlive status` shows running channels and PID