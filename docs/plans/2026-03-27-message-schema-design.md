# Message Schema Layer Design

## Overview

Replace the stringly-typed SSE event stream with a Zod-validated, typed canonical event system. This is the foundation for multi-provider support, subagent message trees, and the bridge-manager refactor.

**Motivation:** The current `sseEvent()`/`parseSSE()` pipeline serializes objects to JSON strings and immediately parses them back — in the same process. There is no runtime validation, no schema, no forward compatibility. When the SDK adds a new field or changes a type, we get silent failures. Happy (slopus/happy, 16.3k stars) solves this with Zod schemas + `.passthrough()` + a normalization layer. We adopt this pattern and go further with a typed `AsyncIterable` replacing the `ReadableStream<string>`.

## Architecture

### Before

```
claude-sdk.ts handleMessage()
  → sseEvent(type, data)        // serialize to "data: {json}\n"
  → ReadableStream<string>
  → conversation.ts parseSSE()  // parse back to object, untyped
  → switch(event.type)          // string matching, no type narrowing
  → bridge-manager callbacks
```

### After

```
claude-sdk.ts handleMessage()
  → claude-adapter.ts adapt()   // SDKMessage → CanonicalEvent (Zod validated)
  → ReadableStream<CanonicalEvent>  // typed objects, no serialization
  → conversation.ts
  → switch(event.kind)          // discriminated union, TS auto-narrows
  → bridge-manager callbacks
```

**Deleted:** `sseEvent()`, `parseSSE()`, `sse-utils.ts`

## Canonical Event Types

```typescript
// Shared base — subagent nesting support
interface BaseEvent {
  parentToolUseId?: string;
}

type CanonicalEvent =
  // Text streaming
  | { kind: 'text_delta'; text: string } & BaseEvent
  // Thinking (hidden from IM display by default — renderer skips these)
  | { kind: 'thinking_delta'; text: string } & BaseEvent

  // Tool lifecycle
  | { kind: 'tool_start'; id: string; name: string;
      input: Record<string, unknown> } & BaseEvent
  | { kind: 'tool_result'; toolUseId: string; content: string;
      isError: boolean } & BaseEvent
  | { kind: 'tool_progress'; toolName: string;
      elapsed: number } & BaseEvent

  // Agent lifecycle
  | { kind: 'agent_start'; description: string;
      taskId?: string } & BaseEvent
  | { kind: 'agent_progress'; description: string; lastTool?: string;
      usage?: { toolUses: number; durationMs: number } } & BaseEvent
  | { kind: 'agent_complete'; summary: string;
      status: 'completed' | 'failed' | 'stopped' } & BaseEvent

  // Query result
  | { kind: 'query_result'; sessionId: string; isError: boolean;
      usage: { inputTokens: number; outputTokens: number; costUsd?: number };
      permissionDenials?: Array<{ toolName: string; toolUseId: string }> }
  | { kind: 'error'; message: string }

  // Auxiliary
  | { kind: 'status'; sessionId: string; model: string }
  | { kind: 'prompt_suggestion'; suggestion: string }
  | { kind: 'rate_limit'; status: string; utilization?: number;
      resetsAt?: number }
```

### Design Decisions

- **`kind` not `type`**: Avoids collision with TypeScript's `type` keyword and SDK's `msg.type` field. Matches Happy's convention.
- **`parentToolUseId`**: Tracks subagent nesting. When Claude dispatches a subagent, all events from that subagent carry the parent's `tool_use_id`. This enables the terminal card renderer to build agent trees.
- **camelCase fields**: Internal canonical format uses camelCase (`toolUseId`, `inputTokens`). The adapter maps from SDK's snake_case.
- **`agent_start` separate from `agent_progress`**: The SDK emits `task_started` as a distinct event. We keep this distinction for clean lifecycle tracking.
- **`thinking_delta` separate from `text_delta`**: The SDK's `content_block_start` has `type: 'thinking'` vs `type: 'text'`. Happy hides thinking entirely (`if (isThinking) return null`). We emit it as a separate event kind so the renderer can choose to hide it (default for IM) or display it (future verbose mode). This prevents thousands of thinking tokens from flooding IM messages.

## Zod Schemas

```typescript
import { z } from 'zod';

const baseSchema = z.object({ parentToolUseId: z.string().optional() });

const textDeltaSchema = z.object({
  kind: z.literal('text_delta'),
  text: z.string(),
}).merge(baseSchema).passthrough();

const thinkingDeltaSchema = z.object({
  kind: z.literal('thinking_delta'),
  text: z.string(),
}).merge(baseSchema).passthrough();

const toolStartSchema = z.object({
  kind: z.literal('tool_start'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()),
}).merge(baseSchema).passthrough();

const toolResultSchema = z.object({
  kind: z.literal('tool_result'),
  toolUseId: z.string(),
  content: z.string(),
  isError: z.boolean(),
}).merge(baseSchema).passthrough();

// ... (all other schemas follow the same pattern)

export const canonicalEventSchema = z.discriminatedUnion('kind', [
  textDeltaSchema,
  thinkingDeltaSchema,
  toolStartSchema,
  toolResultSchema,
  toolProgressSchema,
  agentStartSchema,
  agentProgressSchema,
  agentCompleteSchema,
  queryResultSchema,
  errorSchema,
  statusSchema,
  promptSuggestionSchema,
  rateLimitSchema,
]);
```

All schemas use `.passthrough()` for forward compatibility — unknown fields from future SDK versions are preserved, not stripped or rejected.

### Validation Strategy

- **On produce** (in claude-adapter): Development mode uses `canonicalEventSchema.parse(event)` — fails loud, catches mapping bugs early. Production mode uses direct object construction with TypeScript type checking only (no Zod overhead on high-frequency events like `text_delta`). Controlled via `validate` constructor option on `ClaudeAdapter`.
- **On consume** (in conversation.ts): No validation needed — TypeScript ensures type safety at compile time since the stream is `ReadableStream<CanonicalEvent>`
- **Unknown events from SDK**: Logged as warning, skipped (not propagated). This prevents unknown SDK message types from crashing the bridge.

## Claude Adapter

Maps `SDKMessage` → `CanonicalEvent[]`. One SDK message can produce multiple canonical events (e.g., an `assistant` message with both text and tool_use blocks).

```typescript
// messages/claude-adapter.ts

export class ClaudeAdapter {
  // Track subagent nesting: tool_use_id → parent context
  private sidechainParents = new Map<string, string>();

  adapt(msg: SDKMessage): CanonicalEvent[] {
    switch (msg.type) {
      case 'stream_event': return this.adaptStreamEvent(msg.event);
      case 'assistant':    return this.adaptAssistant(msg);
      case 'user':         return this.adaptUser(msg);
      case 'result':       return this.adaptResult(msg);
      case 'system':       return this.adaptSystem(msg);
      case 'tool_progress': return this.adaptToolProgress(msg);
      case 'rate_limit_event': return this.adaptRateLimit(msg);
      case 'prompt_suggestion': return this.adaptPromptSuggestion(msg);
      default:
        console.warn(`[claude-adapter] Unknown SDK message type: ${msg.type}`);
        return [];
    }
  }
}
```

The adapter is **stateful** — it maintains `sidechainParents` to track which events belong to which subagent, matching Happy's `sidechainLastUUID` pattern.

### Thinking Block Detection

The SDK's `stream_event` contains `content_block_start` with either `type: 'thinking'` or `type: 'text'`. The adapter maps these to different canonical events:

```typescript
private adaptStreamEvent(event: any): CanonicalEvent[] {
  if (event.type === 'content_block_start') {
    // Track whether current block is thinking or text
    this.currentBlockType = event.content_block?.type; // 'thinking' | 'text' | 'tool_use'
  }
  if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
    const kind = this.currentBlockType === 'thinking' ? 'thinking_delta' : 'text_delta';
    return [{ kind, text: event.delta.text }];
  }
  // ... other event handling
}
```

The renderer hides `thinking_delta` events by default — they are not accumulated into `responseText` and not displayed in the terminal card. This prevents thousands of thinking tokens from flooding IM messages (matching Happy's approach of `if (isThinking) return null`).

### Hidden Tool Filtering

Internal tools that provide no user-visible value are filtered at the adapter level (inspired by Happy's `hidden: true` flag in `knownTools`):

```typescript
const HIDDEN_TOOLS = new Set([
  'ToolSearch', 'TodoRead', 'TodoWrite',
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskStop',
]);

// In adaptStreamEvent / adaptAssistant:
if (block.type === 'tool_use' && HIDDEN_TOOLS.has(block.name)) {
  return []; // Don't emit tool_start for hidden tools
}
```

This keeps the terminal card's rolling window focused on tools the user cares about (Read, Edit, Bash, Grep, etc.), not Claude's internal task management.

The adapter also maintains `hiddenToolUseIds: Set<string>` to track tool_use IDs of hidden tools. When a `tool_result` arrives for a hidden tool, it is also filtered out — preventing orphaned results without matching `tool_start` events.

### Subagent Nesting Logic

```typescript
// When SDK sends a message with parent_tool_use_id, all events
// from that context carry the parentToolUseId field
private getParentToolUseId(msg: SDKMessage): string | undefined {
  if ('parent_tool_use_id' in msg && msg.parent_tool_use_id) {
    return msg.parent_tool_use_id as string;
  }
  return undefined;
}
```

## SessionMode Type

Consolidates the scattered per-chat configuration Maps in bridge-manager into a single typed object. Inspired by Happy's `EnhancedMode`.

```typescript
export interface SessionMode {
  permissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  systemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
}
```

This type is **defined** in this sub-project but **used** in sub-project 2 (bridge-manager refactor). The bridge-manager will replace:
- `permModes: Map<string, 'on' | 'off'>`
- `effortLevels: Map<string, string>`
- (future) model overrides, system prompts

with `sessionModes: Map<string, SessionMode>`.

## ProviderBackend Interface

Provider-agnostic interface for multi-provider support. Only Claude is implemented now; Codex/Gemini can be added later by implementing this interface.

```typescript
export interface ProviderBackend {
  /** Start a query and return a typed event stream */
  startQuery(params: {
    prompt: string;
    workingDirectory: string;
    sessionId?: string;
    mode: SessionMode;
    attachments?: FileAttachment[];
    onPermissionRequest?: PermissionRequestHandler;
    onAskUserQuestion?: AskUserQuestionHandler;
  }): {
    stream: ReadableStream<CanonicalEvent>;
    controls?: QueryControls;
  };

  dispose(): Promise<void>;
}
```

**vs. Happy's `AgentBackend`:** We use `ReadableStream<CanonicalEvent>` instead of callback-based `onMessage(handler)`. Simpler, composable with `for await...of`, and matches the existing consumption pattern in `conversation.ts`.

**vs. current `LLMProvider`:** The current `streamChat()` returns `ReadableStream<string>`. The new `startQuery()` returns `ReadableStream<CanonicalEvent>`. Same structure, typed output.

**Migration strategy:** This sub-project only updates `LLMProvider.streamChat()` to return `ReadableStream<CanonicalEvent>` instead of `ReadableStream<string>`. The `ProviderBackend` interface is defined in `messages/types.ts` but NOT implemented yet — `ClaudeSDKProvider` continues to implement `LLMProvider`. Sub-project 2 will migrate to `ProviderBackend` when refactoring bridge-manager.

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `bridge/src/messages/schema.ts` | Zod schemas + CanonicalEvent type + parse/validate helpers |
| Create | `bridge/src/messages/claude-adapter.ts` | SDKMessage → CanonicalEvent[] mapping with subagent tracking |
| Create | `bridge/src/messages/types.ts` | SessionMode, ProviderBackend, AgentUsage, QueryControls |
| Create | `bridge/src/messages/index.ts` | Public exports |
| Create | `bridge/src/__tests__/message-schema.test.ts` | Schema validation tests |
| Create | `bridge/src/__tests__/claude-adapter.test.ts` | Adapter mapping + subagent nesting tests |
| Modify | `bridge/src/providers/claude-sdk.ts` | Use ClaudeAdapter, emit CanonicalEvent stream, implement ProviderBackend |
| Modify | `bridge/src/providers/base.ts` | StreamChatResult.stream → ReadableStream\<CanonicalEvent\>, re-export ProviderBackend |
| Modify | `bridge/src/engine/conversation.ts` | Delete parseSSE, consume CanonicalEvent, switch on kind |
| Modify | `bridge/src/engine/bridge-manager.ts` | Match new event kinds in callbacks |
| Delete | `bridge/src/providers/sse-utils.ts` | Replaced by messages/ module |
| Delete | `bridge/src/__tests__/sse-utils.test.ts` | Replaced by new tests |

## Migration Path

1. Create `messages/` module with schemas, adapter, types
2. Update `claude-sdk.ts` to use `ClaudeAdapter` and produce `ReadableStream<CanonicalEvent>`
3. Update `conversation.ts` to consume typed events (switch `event.type` → `event.kind`)
4. Update `bridge-manager.ts` callback signatures
5. Delete `sse-utils.ts` and its tests
6. All existing tests updated to match new event format

## conversation.ts Changes

Before:
```typescript
const event = parseSSE(value);
if (!event) continue;
switch (event.type) {
  case 'text':
    fullText += event.data as string;
    params.onTextDelta?.(event.data as string);
    break;
  case 'tool_use':
    params.onToolUse?.(event.data as ToolUseEvent['data']);
    break;
```

After:
```typescript
// value is already a CanonicalEvent — no parsing needed
switch (value.kind) {
  case 'text_delta':
    fullText += value.text;
    params.onTextDelta?.(value.text);
    break;
  case 'tool_start':
    params.onToolStart?.(value);
    break;
  case 'tool_result':
    params.onToolResult?.(value);
    break;
```

The callback signatures in `ProcessMessageParams` change from SSE-typed events to canonical events:
- `onToolUse` → `onToolStart` (matches canonical kind)
- Event data is directly typed, no `as` casts needed
- `thinking_delta` events are **not** accumulated into `fullText` — thinking is internal reasoning, not user-facing output
- Hidden tool events never reach conversation.ts (filtered at adapter level)

## What This Enables (Future Sub-Projects)

1. **Sub-project 2: Bridge-manager refactor** — SessionMode replaces scattered Maps, graduated permission buttons (tool-specific "Yes for this tool" with dynamic session whitelist, inspired by Happy's PermissionFooter), conditional message delay queue (250ms tool delay with early release on permission/result)
2. **Sub-project 3: Message encryption** — Encrypt CanonicalEvent payloads before sending to IM (symmetric key, user decrypts)
3. **Sub-project 4: Multi-provider** — Implement `ProviderBackend` for Codex/Gemini, adapter maps their events to same CanonicalEvent stream
4. **Sub-project 5: Message tree** — `parentToolUseId` enables reducer-style state accumulation for subagent trees

## Out of Scope

- Codex/Gemini adapter implementation (future sub-project)
- Bridge-manager Map consolidation to SessionMode (sub-project 2)
- Graduated permission buttons / dynamic session whitelist (sub-project 2)
- Conditional message delay queue (sub-project 2)
- PushableAsyncIterable for mid-conversation injection (sub-project 2 — note: only works between turns, not mid-execution)
- Message encryption (sub-project 3)
- Zod dependency — already in devDependencies via vitest; add as runtime dep

## Patterns Borrowed from Happy (slopus/happy)

| Pattern | Happy's Implementation | Our Adaptation |
|---------|----------------------|----------------|
| Zod + `.passthrough()` | `RawJSONLinesSchema`, `sessionEventSchema` | `canonicalEventSchema` with discriminated union |
| Subagent parent tracking | `sidechainLastUUID: Map` | `parentToolUseId` field on BaseEvent |
| Thinking block suppression | `if (isThinking) return null` | `thinking_delta` separate event kind, renderer hides |
| Hidden internal tools | `hidden: true` in `knownTools` | `HIDDEN_TOOLS` set in adapter, events not emitted |
| Provider abstraction | `AgentBackend` interface with callback-based `onMessage` | `ProviderBackend` with `ReadableStream<CanonicalEvent>` |
| Mode bundling | `EnhancedMode` type | `SessionMode` type |
| Message normalization | `SDKToLogConverter` class | `ClaudeAdapter` class |

## Where We Surpass Happy

| Aspect | Happy | TermLive |
|--------|-------|----------|
| Type safety | Zod on wire protocol only | **Zod on canonical events + TypeScript discriminated union** |
| Serialization | JSON strings between layers | **Direct typed objects (zero serialization overhead)** |
| Stream model | Callback-based `onMessage(handler)` | **`ReadableStream<CanonicalEvent>` — composable, backpressure-aware** |
| Validation location | Consumer-side (app parses) | **Producer-side (adapter validates) — fail fast** |
| Event granularity | Coarse (agent-level) | **Fine-grained (tool_start/result/progress + agent lifecycle)** |
