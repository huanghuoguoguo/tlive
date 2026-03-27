# Terminal-Style Card Display Design

## Overview

Refactor the IM bridge display from a single monolithic streaming card to a terminal-emulation card that shows tool calls, permission prompts, and responses in a continuous scrolling view — matching Claude Code's terminal experience.

## Core Concept

**One card = one terminal window.** The card content continuously updates in place, simulating terminal scrolling. Permission prompts appear inline at the bottom and disappear after approval. The full lifecycle of a Claude Code query lives inside a single card.

## Card Lifecycle

### Phase 1: Tool Execution (scrolling)
```
● Explore(Explore TermLive codebase)
├ Bash(find ... *.json)
├ Bash(tree -L 3 ...)
├ Bash(ls -la bridge/)
└ +6 more tool uses
```

- Each tool call appends to a **rolling window** (last N entries)
- Older entries collapse into `+N more tool uses`
- Current running tool shows `🔄 Running...`
- Agent/subagent context shown as tree headers (`● AgentName(description)`)

### Phase 2: Permission Prompt (blocking)
```
● Explore(Explore TermLive codebase)
├ Bash(find ... *.json)
├ Bash(tree -L 3 ...)
├ +4 more
━━━━━━━━━━━━━━━━━━
🔐 Bash: tree ... -type d | head -40
Show directory tree structure
[✅ Yes] [📌 Always] [❌ No]
```

- Permission section appears at card bottom (below separator)
- Tool scrolling pauses (blocked on canUseTool)
- User clicks button → permission section disappears, tool resumes in the log
- No trace left of the permission prompt (matches terminal behavior)

### Phase 3: Text Response (final)
```
● Explore(Explore TermLive codebase)
├ ... (23 tools, 45s)
━━━━━━━━━━━━━━━━━━
## 审查报告
发现 3 个问题...

📊 9/2.7k tok | $0.28 | 2m 57s
```

- Tool log collapses to summary
- Claude's text response replaces the working area
- Cost line appended at bottom

## Card Structure (Feishu CardKit)

Multiple elements with independent updates:

| Element ID | Content | Update Frequency |
|-----------|---------|-----------------|
| `tool_log` | Rolling window of tool calls | Every tool call (~300ms throttle) |
| `permission` | Permission prompt + buttons (when needed) | On canUseTool / on approval |
| `response` | Claude's text output | Streaming text deltas |
| `footer` | Cost line / status | On complete |

- `tool_log`: markdown element, updated via `cardElement.content()`
- `permission`: column_set with button elements, added/removed dynamically
- `response`: markdown element, streaming updates
- `footer`: markdown element, set on complete

### Telegram / Discord Fallback

No element-level updates. Use `editMessageText` / embed edit to replace the entire card content on each update. Same logical structure, just rebuilt as a single string/embed on each flush.

## Rolling Window

- **Window size**: 8 entries (configurable)
- **Collapse**: entries beyond window → `+N more tool uses`
- When a new tool starts, oldest entry drops off
- Agent tree headers count as entries

### Size Control

| Platform | Limit | Strategy |
|---------|-------|---------|
| Feishu | ~28KB card JSON | Rolling window keeps content bounded |
| Telegram | 4,096 chars | Smaller window (5 entries), truncate tool args |
| Discord | 6,000 chars embed | Medium window (6 entries) |

## Display Format (matching terminal)

### Tool Calls — tree structure with results

```
● Explore(Explore TermLive codebase)
├  Done (42 tool uses · 52.3k tokens · 1m 50s)

● Bash(npm test 2>&1 | tail -40)
├  + Received:
│    false
│    … +24 lines

● TermLive 项目全面检查报告
  项目概况
  TermLive (tlive) v0.2.9 — AI 编码工具的终端监控...
```

Each entry is a **block**:
- `●` prefix = top-level tool call or text block
- `├ └ │` tree connectors for nested results
- Agent subagents show as nested trees with their own tool calls
- Text output from Claude shown as a block with `●` prefix (no tool header)

### Agent / Subagent nesting

```
● Running 2 Explore agents...
├─ Read failing test files · 5 tool uses · 13.0k tokens
│    Reading 5 files...
├─ Read source files for tests · 10 tool uses · 44.6k tokens
│    Reading 10 files...

● Let me先详细了解失败的测试和对应的源码。
```

- Parent agent shows as a header with child count
- Child agents show with `├─` nesting, stats inline
- Progress shown under each child (`Reading 5 files...`)

### Status indicators

```
●  — completed tool/text block
🔄 — currently running (replaces ● while executing)
*  — thinking/processing (like terminal's "Skedaddling...")
```

### Tool result format

| Scenario | Display |
|---------|---------|
| Bash with output | `● Bash(cmd)\n├  output preview\n│  … +N lines` |
| Read file | `● Read(filename.ts)` (no output shown) |
| Agent completed | `● AgentName(desc)\n├  Done (N tools · Nk tokens · Ns)` |
| Agent running | `🔄 Running N agents...\n├─ child1\n├─ child2` |
| Text from Claude | `● Text content here...` |
| Error | `● Bash(cmd)\n├  ❌ Error: message` |

### Permission Prompt (inline, blocking)

Appears at bottom of card when canUseTool fires:

```
━━━━━━━━━━━━━━━━━━
🔐 Bash command
  tree -L 3 ... -type d | head -40
  Show directory tree structure

[✅ Yes] [📌 Always] [❌ No]
```

- Full command shown (user needs to see what they're approving)
- SDK's `decisionReason` as description
- Three buttons

### After Approval
- Entire permission section (separator + prompt + buttons) removed
- Tool appears in log as normal `● Bash(...)` entry with result
- Single editMessage call updates the card

## Implementation Architecture

### New: `TerminalCardRenderer`

Replaces `StreamController`. Single class that owns the card state and renders it.

```typescript
class TerminalCardRenderer {
  // State
  private toolEntries: ToolEntry[] = [];     // rolling window
  private collapsedCount = 0;                // "+N more"
  private pendingPermission?: PermissionState;
  private responseText = '';
  private costLine?: string;
  private currentAgent?: string;

  // Public API (called by bridge-manager)
  onToolStart(name: string, input: Record<string, unknown>): void;
  onToolComplete(toolUseId: string, result?: string): void;
  onToolDenied(toolUseId: string): void;
  onAgentStart(description: string): void;
  onAgentComplete(summary: string): void;
  onPermissionNeeded(toolName: string, input: string, reason: string, buttons: Button[]): void;
  onPermissionResolved(): void;
  onTextDelta(text: string): void;
  onComplete(costLine: string): void;

  // Rendering
  private render(): string;  // builds card content from state
  private flush(): void;     // sends render() to adapter
}
```

### Integration with bridge-manager

```
canUseTool called
  → renderer.onPermissionNeeded(tool, input, reason, buttons)
  → flush (card shows permission section)
  → wait for gateway
  → renderer.onPermissionResolved()
  → flush (permission section removed, tool added to log)
```

### Feishu-specific: CardKit Multi-Element

For Feishu, the renderer creates the card with multiple `element_id`s and uses `cardElement.content()` for independent updates. This avoids re-sending the entire card JSON on every tool call.

For Telegram/Discord, the renderer rebuilds the full content string and calls `editMessageText`.

## Verbose Levels

- **verbose 0**: No card during execution. Only send the final response text.
- **verbose 1** (default): Full terminal card — tool log, permissions, response.

No verbose 2. Two levels are sufficient for IM.

## What This Replaces

| Current | New |
|---------|-----|
| `StreamController` class | `TerminalCardRenderer` class |
| `feishu-streaming.ts` CardKit session | Integrated into renderer (Feishu path) |
| Separate permission cards via broker | Permission section inside the terminal card |
| `compactToolSummary()` | Rolling window log |
| `onAgentProgress()` / `onAgentComplete()` | Agent tree headers in log |
| `onToolProgress()` for long-running | ⏳ elapsed timer in log entry |

## AskUserQuestion Handling

SDK's `canUseTool` fires with `toolName === "AskUserQuestion"` when Claude needs clarifying input. Input format:

```json
{
  "questions": [{
    "question": "How should I format the output?",
    "header": "Format",
    "options": [
      { "label": "Summary", "description": "Brief overview" },
      { "label": "Detailed", "description": "Full explanation" }
    ],
    "multiSelect": false
  }]
}
```

Display in the terminal card as interactive section (similar to permission prompt):

```
━━━━━━━━━━━━━━━━━━
❓ Format: How should I format the output?

1. Summary — Brief overview
2. Detailed — Full explanation

[1️⃣ Summary] [2️⃣ Detailed]
```

For `multiSelect: true`, allow multiple selections. User can also reply with text (mapped as free-text answer).

Response format back to SDK:
```typescript
return {
  behavior: 'allow',
  updatedInput: {
    questions: input.questions,
    answers: { "How should I format the output?": "Summary" }
  }
};
```

**Limitation**: AskUserQuestion is NOT available in subagents.

## Permission Button Design

SDK officially supports only `allow` and `deny` responses. The "Always" concept (`updatedPermissions` + `suggestions`) exists in TypeScript types but is undocumented.

Button options:
- **✅ Yes** → `{ behavior: 'allow', updatedInput: input }`
- **❌ No** → `{ behavior: 'deny', message: 'User denied this action' }`
- **📌 Always** → `{ behavior: 'allow', updatedInput: input, updatedPermissions: options.suggestions }` (best-effort, may not persist across subagents)

## SDK Integration Points

### `setPermissionMode()` — Dynamic Permission Changes

The SDK supports changing permission mode mid-session via `Query.setPermissionMode()`. The `/perm` command should use this instead of just controlling `canUseTool`:

- `/perm off` → `query.setPermissionMode('acceptEdits')` or `'bypassPermissions'`
- `/perm on` → `query.setPermissionMode('default')`
- `/perm plan` → `query.setPermissionMode('plan')` (read-only mode)

### `includePartialMessages: true`

Already enabled. Provides `stream_event` messages with `content_block_delta` for real-time text and tool input streaming. The terminal card renderer should use these for:
- Live text streaming (character by character)
- Tool input streaming (show command being typed)

### Query Runtime Controls

All available mid-session via the Query object:

| Method | IM Command | Description |
|--------|-----------|-------------|
| `interrupt()` | `/stop` | Stop current turn |
| `stopTask(taskId)` | (auto) | Stop a runaway subagent |
| `setPermissionMode(mode)` | `/perm off\|on\|plan` | Change permission mode live |
| `setModel(model)` | `/model sonnet\|opus` | Switch model mid-session |
| `applyFlagSettings(settings)` | (internal) | Update permission rules dynamically |
| `streamInput(stream)` | user messages | Send follow-up messages mid-execution |
| `supportedCommands()` | `/skills` | List available slash commands |
| `accountInfo()` | `/account` | Show account info |

### Streaming Input

SDK supports `Query.streamInput()` to send follow-up messages mid-execution. The IM bridge can use this for:
- User replies during long-running tasks
- Interrupt + redirect ("stop that, do this instead")

### Structured Outputs

SDK supports `outputFormat: { type: 'json_schema', schema }` for validated JSON responses. Not needed for the terminal card, but useful for future features (e.g., structured code review reports).

## Out of Scope

- Multi-card design (rejected — single card matches terminal metaphor)
- Per-tool-call separate messages (rejected — too noisy)
- verbose 2 terminal-level detail (YAGNI for IM)
- Web terminal integration (separate feature)
- V2 Session API (marked @alpha/unstable, revisit when stable)
