# Troubleshooting

## Bridge will not start

Symptoms: `tlive start` or `/tlive start` fails, or the daemon exits quickly.

Steps:
1. Run `tlive doctor`.
2. Check Node.js: `node --version`.
3. Check Claude Code: `claude --version`.
4. Verify config exists: `ls -la ~/.tlive/config.env`.
5. Check logs: `tlive logs 200`.

Common causes:
- Missing or invalid `config.env`: run `/tlive setup`.
- Node.js too old: use Node.js 20+.
- Port conflict: run `tlive status` and inspect the configured ports.
- Stale PID file: stop first with `tlive stop`, then retry.

## Feishu messages not received

Symptoms: the Feishu bot is visible but TLive does not react to messages.

Steps:
1. Run `tlive doctor`.
2. Validate Feishu credentials with `references/token-validation.md`.
3. Confirm the Feishu app is published and admin-approved.
4. Confirm **Long Connection** mode is enabled.
5. Confirm these events are subscribed:
   - `im.message.receive_v1`
   - `card.action.trigger`
6. Check allowed users in `TL_FS_ALLOWED_USERS`.
7. Inspect incoming logs: `tlive logs 200`.

## Permission approval not working

Symptoms: Claude Code asks for tool permission but Feishu buttons do not work,
or permission waits time out.

Steps:
1. Run `tlive install skills`.
2. Check the bridge is running: `tlive status`.
3. Check hooks are active: `tlive hooks`.
4. Confirm `card.action.trigger` is subscribed and approved in Feishu.
5. Inspect recent permission logs:

```bash
grep "\[perm\]" ~/.tlive/logs/bridge-*.log | tail -50
```

Look for `REQUEST`, `RESOLVED`, and `TIMEOUT`.

## Streaming cards not updating

Symptoms: Feishu only receives the final answer, or progress cards stop
refreshing.

Steps:
1. Run `tlive status`.
2. Check logs for Feishu API errors: `tlive logs 200`.
3. Confirm card permissions are granted:
   - `cardkit:card:read`
   - `cardkit:card:write`
4. Check for rate limiting or card patch failures in logs.

## Session issues

Use request IDs and session IDs from logs:

```bash
grep "\[query\]" ~/.tlive/logs/bridge-*.log | tail -80
```

Common signals:
- `SESSION_EXPIRED`: the Claude SDK session rotated.
- `SESSION_STALE`: the saved Claude SDK session is no longer valid.
- `QUEUE_FULL`: messages are arriving faster than they can be processed.

## Log Flow

Successful message processing:

```text
[feishu] a1b2c3d4 RECV user=xxx chat=...abcd: hello
[query] a1b2c3d4 START session=ef12 cwd=~/proj
[query] a1b2c3d4 COMPLETE tokens=100+200 cost=0.0012$
[query] a1b2c3d4 SENT msgId=msg_5678
```

Permission flow:

```text
[perm] a1b2c3d4 REQUEST Bash permId=3456
[perm] a1b2c3d4 RESOLVED Bash permId=3456 -> allow
```

Tips:
- Start from the request ID when a user reports a specific message.
- Error logs are in `~/.tlive/logs/*-error.log`.
- Use `tail -f ~/.tlive/logs/bridge-$(date +%Y-%m-%d).log` during live tests.
