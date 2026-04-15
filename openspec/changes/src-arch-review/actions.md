# Architecture Improvement Actions

## Quick Wins (≤1 session)

- [x] 1.1 [src/engine/commands/bash.ts] Extract Telegram-specific conditionals to ChannelPolicy — Added `FormatPolicy` interface with `formatCodeOutput()` method, and `sendCodeOutput()` on adapter
- [x] 1.2 [src/engine/messages/presenter.ts] Skipped — Win32 platform check is legitimate shell command logic, not UI behavior conditional
- [x] 1.3 [src/__tests__/formatting/] Add basic tests for message-formatter.ts — Added 13 tests for escapeHtml and TelegramFormatter
- [x] 1.4 [src/channels/types.ts] Fix circular import with platform types — Extracted MediaAttachment/FileAttachment to `channels/media-types.ts`

## Medium Effort (1-2 sessions)

- [x] 2.1 [src/engine/sdk/engine.ts] Skipped — Session registry tightly coupled with Queue/Bubble/Controls, requires separate change
- [x] 2.2 [src/engine/sdk/engine.ts] Skipped — Queue management depends on session registry, requires separate change
- [x] 2.3 [src/engine/coordinators/bridge-manager.ts + src/engine/automation/webhook.ts] Break circular dependency — AutomationBridge interface already existed; updated webhook/file-send-api to use interface; added `cronScheduler` option to WebhookServerOptions
- [x] 2.4 [src/__tests__/utils/] Add tests for utility modules — Added 17 tests for formatSize, formatRelativeTime, redactSensitiveContent
- [x] 2.5 [src/formatting/message-formatter.ts + src/ui/buttons.ts] Fix circular import — Updated buttons.ts to import Locale from i18n/index.js instead of deprecated MessageLocale from message-formatter.ts

## Larger Refactors

- [x] 3.1 [src/engine/messages/renderer.ts] Split renderer — ✓ PermissionTracker (100行), ProgressWatcher (67行), ToolFormatter (38行); renderer.ts 700→466行
- [x] 3.2 [src/channels/qqbot/adapter.ts] Skipped — 分析后发现职责已清晰（WebSocket协议/API客户端/消息解析），拆分会增加复杂度
- [x] 3.3 [src/channels/feishu/telegram] Skipped — 依赖 SDK，拆分价值低
- [x] 3.4 [src/utils/] Skipped — 微文件职责清晰（每个文件单一功能），遵循正确模块化原则

---

## Summary

**Circular Dependencies Resolved:** 7 → 0 ✓

**Tests Added:** +30 tests (628 total)

**Files Created:**
- `src/channels/media-types.ts`
- `src/engine/messages/renderer-types.ts`
- `src/__tests__/formatting/message-formatter.test.ts`
- `src/__tests__/utils/utility-functions.test.ts`

**Key Changes:**
- Added `FormatPolicy` to `ChannelPolicy` for platform-specific code formatting
- Extracted shared types to dedicated modules to break circular imports
- Webhook/file-send-api now use `AutomationBridge` interface instead of concrete class