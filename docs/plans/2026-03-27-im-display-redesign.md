# IM Display Redesign — "Clean Result"

## Overview

Redesign the IM message display system from a terminal emulator approach (tool tree in code block) to a clean, chat-native experience. One message per turn, editMessage-based lifecycle, zero spam.

**Core principle:** Process is noise, result is content.

## Message Lifecycle

One message goes through three phases via editMessage:

### Phase 1: Executing (real-time updates)

```
⏳ 🖥 Bash ×3 · 📖 Read ×2 (5 tools · 12s)
```

- Each tool completion increments the counter, triggers editMessage
- Throttled to 300ms to respect API rate limits
- Tool icons from existing `TOOL_ICONS` mapping, ordered by first appearance
- Count always shown as `×N` even when N=1 for consistency
- Unregistered tools use `🔧` fallback
- Parentheses: total tool count + elapsed time (time ticks every second)
- Before first tool completes: `⏳ Starting...`

### Phase 2: Permission Morph (blocking)

```
🔐 Bash: npm test -- schema.test.ts
[Allow] [Deny]
```

- Same message morphs to permission request + inline buttons
- Claude is blocked — no new content will overwrite this
- After user clicks: message morphs back to Phase 1 (renderer preserves tool counts in memory, restores status line), counting resumes
- Timeout fallback: after 60s with no response, send a separate reminder message with the same buttons
- Reminder after resolution: `Bash: npm test ✅` (allow) or `Bash: npm test ❌` (deny), buttons removed

### Phase 3: Done (final form)

```
Claude's response text, rendered as markdown.
Supports code blocks, lists, links, etc.
───────────────
🖥 Bash ×76 · 📖 Read ×55 · 🔍 Grep ×6 · 🤖 Agent ×3 (140 total)
📊 9.2k/2.7k tok · $0.28 · 2m 57s
```

- Response text rendered through per-platform markdown converters
- Separator: Feishu uses `hr` element, Telegram/Discord use `───`
- Footer two lines: tool summary + cost
- No `⏳` prefix, parentheses show `total` instead of elapsed time
- Cost line format reuses existing `CostTracker.format()`

## Platform Rendering

Unified interaction logic, per-platform format adaptation:

### Feishu — Interactive Card

```json
{
  "schema": "2.0",
  "header": null,
  "body": {
    "elements": [
      { "tag": "markdown", "content": "Response text..." },
      { "tag": "hr" },
      { "tag": "markdown", "content": "🖥 Bash ×76 · 📖 Read ×55\n📊 9.2k tok · $0.28" }
    ]
  }
}
```

- No header (saves space)
- Permission phase: markdown element replaced with permission text + button elements

### Telegram — HTML + Inline Keyboard

```html
Response text (HTML rendered)

───────────────
🖥 Bash ×76 · 📖 Read ×55
📊 9.2k tok · $0.28 · 2m 57s
```

- `parse_mode: 'HTML'`
- Permission phase: `reply_markup: { inline_keyboard: [[Allow, Deny]] }`
- 4096 char limit — footer ~80 chars, ~4000 available for response

### Discord — Embed

```
Embed {
  description: "Response text...",
  footer: { text: "🖥 Bash ×76 · 📖 Read ×55 | 📊 $0.28 · 2m 57s" },
  color: 0x7C3AED
}
```

- Tool summary + cost merged into `footer.text` (one line, `|` separator)
- Permission phase: ActionRow button components attached
- 6000 char embed limit

## Long Output Overflow

When response exceeds platform character limit:

```
Message 1 (editMessage): First N chars of response
Message 2 (send):        Middle segment
Message 3 (send):        Final segment + separator + footer
```

- Split at paragraph boundaries (`\n\n`) first, then code block boundaries
- Reuse existing `chunkByParagraph()` logic
- Footer always on the last message

## Agent Display

Flat. Agents counted as `🤖 Agent ×N` alongside other tools. No nesting, no descriptions, no tree. Agent output is reflected in Claude's final response.

## Error & Edge Cases

### Tool execution error

No special handling. Errors are part of Claude's response — Claude explains what went wrong. Tools count normally regardless of success/failure.

### User interrupt (/stop)

```
⚠️ Stopped
───────────────
🖥 Bash ×3 · 📖 Read ×2 (5 tools · 12s)
```

- If partial response exists: show partial text + footer
- If no response: `⚠️ Stopped` + footer

### Connection lost / SDK error

```
❌ Connection lost. Use /new to start a new session.
```

editMessage replaces status line. No footer (meaningless).

### Empty response

No response text, no separator. Just the footer:

```
🖥 Bash ×3 · ✏️ Edit ×2 · 📖 Read ×1 (6 total)
📊 4.1k/0.8k tok · $0.12 · 8s
```

### Concurrent requests

Queue — don't create a second status message. Reuse existing `processingChats` lock.

## Architecture Changes

### Rewrite: `TerminalCardRenderer` → `MessageRenderer`

Old: tool entry list, tree structure, scroll window, code block rendering.
New: tool counter `Map<string, number>`, total count, phase enum.

```typescript
interface MessageRenderer {
  toolCounts: Map<string, number>;  // 'Bash' → 76
  totalTools: number;
  phase: 'executing' | 'permission' | 'done';
  responseText: string;

  onToolStart(name: string): void;
  onToolComplete(toolUseId: string): void;
  onPermissionNeeded(tool: string, input: string, permId: string): void;
  onPermissionResolved(permId: string, decision: string): void;
  onTextDelta(text: string): void;
  onComplete(usage: UsageStats): void;

  render(): RenderedMessage;
}
```

### Unchanged

- `CanonicalEvent` schema — events unchanged
- `ClaudeAdapter` / `CodexAdapter` — upstream unchanged
- `PermissionCoordinator` — permission flow unchanged
- `ConversationEngine` — only callback interface names change
- Markdown converters — response rendering unchanged
- `DeliveryLayer` — chunking logic reused

### Removed

- `ToolEntry[]` list
- Tree building (`childTools`, `parentToolUseId` rendering)
- Scroll window (`enforceWindow`, `collapsedCount`)
- Code block wrapping for tool logs
- `pendingTool` 250ms buffer (counters don't need buffering)
- `AgentEntry[]` list

### Added

- Permission timeout timer: 60s → send separate reminder
- Overflow detection: check platform char limit after render, trigger chunking
