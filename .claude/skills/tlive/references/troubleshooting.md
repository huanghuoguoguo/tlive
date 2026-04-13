# Troubleshooting

## Bridge won't start

**Symptoms**: `tlive start` or `/tlive start` fails, or daemon exits immediately.

**Steps**:
1. Run `/tlive doctor` to identify the issue
2. Check Node.js >= 22: `node --version`
3. Check Claude Code CLI: `claude --version`
4. Verify config exists: `ls -la ~/.tlive/config.env`
5. Check logs: `/tlive logs`

**Common causes**:
- Missing or invalid config.env → run `/tlive setup`
- Node.js not found or wrong version → install Node.js >= 22
- Port conflict → check if another instance is running with `/tlive status`
- Stale PID file → `rm ~/.tlive/runtime/bridge.pid` and retry

## Messages not received

**Symptoms**: Bot is online but doesn't respond to messages.

**Steps**:
1. Verify token is valid: `/tlive doctor`
2. Check allowed user IDs in config — only listed users can interact
3. For Telegram: ensure you've sent `/start` to the bot first
4. For Telegram: ensure you've sent `/start` to the bot first
5. For Feishu: confirm app is approved and event subscriptions are configured
6. For QQ Bot: verify app credentials and whitelist
7. Check logs for incoming messages: `/tlive logs 200`

## Hook approval not working

**Symptoms**: Claude Code runs without sending permission requests to phone.

**Steps**:
1. Verify the `/tlive` skill is installed: `tlive install skills`
2. Check Claude Code settings in `~/.claude/settings.json`
3. Check hooks aren't paused: `tlive hooks`
4. Verify the bridge is running: `tlive status`
5. Check recent bridge logs: `/tlive logs 200`

## Streaming not working

**Symptoms**: Bot sends final response only, no real-time updates.

**Steps**:
1. Check the bridge is healthy with `/status` or `tlive logs`
2. For Feishu: verify `editMessage` card patching works (check logs for API errors)
3. Check delivery rate limiting — rapid edits may be throttled

## High memory usage

**Symptoms**: Bridge process consumes increasing memory over time.

**Steps**:
1. Check status: `/tlive status`
2. Restart: `/tlive stop` then `/tlive start`
3. Check for large conversation buffers in logs
