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

## Tool Log Entry Format

```
✅ Bash(npm run test) → 12 passed          # completed with short result
✅ Read(package.json)                        # completed, no result shown
❌ Write(/tmp/test.txt) → denied             # permission denied
🔄 Bash(npm run build)                      # currently running
⏳ Bash(npm run build) 8s                   # long-running (>3s shows elapsed)
```

- Tool name + truncated args (max 60 chars)
- Optional short result after `→` (first line, max 40 chars)
- Status icon: ✅ done, ❌ denied, 🔄 running, ⏳ long-running

## Permission Prompt Format

```
━━━━━━━━━━━━━━━━━━
🔐 Bash command
  tree -L 3 ... -type d | head -40
  Show directory tree structure

[✅ Yes] [📌 Always] [❌ No]
```

- Separator line above
- Tool name as header
- Full command/input (not truncated — user needs to see what they're approving)
- SDK's `decisionReason` as description
- Three buttons

### After Approval
- Entire permission section (separator + prompt + buttons) is removed
- The approved tool appears in the tool log as a normal `✅` entry
- Card content updates in one editMessage call

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

## Out of Scope

- Multi-card design (rejected — single card matches terminal metaphor)
- Per-tool-call separate messages (rejected — too noisy)
- verbose 2 terminal-level detail (YAGNI for IM)
- Web terminal integration (separate feature)
