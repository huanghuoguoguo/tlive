# OpenAI Provider Integration for tlive

**Date:** 2026-04-26
**Status:** Draft

## Summary

Add OpenAI as an alternative AI provider to tlive, enabling users to switch between Claude and OpenAI engines via IM commands. Implement a minimal but functional OpenAI Agent using OpenAI SDK with core tools (Bash, Read, Write, Edit) and streaming output.

## Goals

- Multi-engine support: Claude + OpenAI running concurrently
- User switchable: `/runtime openai` or `/runtime claude` in IM
- Core tools: Bash, Read, Write, Edit
- Streaming output: Real-time thinking/text deltas to IM
- Minimal complexity: MVP for fast validation

## Non-Goals

- Permission approval system (canUseTool) - optional, not in MVP
- Glob/Grep search tools - optional, can add later
- Multi-turn conversation state persistence - single query per turn for MVP
- OpenAI Responses API - experimental, may add later

## Architecture

### Component: OpenAIProvider

New class `OpenAIProvider` implementing the same interface as `ClaudeSDKProvider`:

```
src/providers/
  ├── base.ts          # LiveSession interface (unchanged)
  ├── claude-sdk.ts    # Claude provider (unchanged)
  ├── claude-live-session.ts
  ├── openai-provider.ts  # NEW: OpenAI provider
  └── openai-live-session.ts # NEW: OpenAI session
```

### Component: Tool Definitions

Define OpenAI function tools for core operations:

```
src/providers/openai-tools.ts  # NEW: Tool schemas for Bash/Read/Write/Edit
```

### Data Flow

```
IM Command → Engine → OpenAIProvider → OpenAI API (streaming)
                ↓
         Tool Execution (local)
                ↓
         CanonicalEvent Stream → IM
```

1. User sends message via IM
2. Engine detects runtime setting (claude/openai)
3. Provider.createSession() or Provider.streamChat()
4. OpenAI API returns streaming response with tool calls
5. Local tool executor runs Bash/Read/Write/Edit
6. Results fed back to API (multi-step if needed)
7. All events mapped to CanonicalEvent for IM rendering

## Implementation Details

### OpenAIProvider Class

```typescript
export class OpenAIProvider {
  private client: OpenAI;
  private defaultModel: string;

  constructor(apiKey: string, model?: string) {
    this.client = new OpenAI({ apiKey });
    this.defaultModel = model || 'gpt-4o';
  }

  streamChat(params: StreamChatParams): StreamChatResult {
    // Streaming chat completion with tools
  }

  createSession(params): LiveSession {
    // Create OpenAILiveSession
  }
}
```

### Tool Definitions

| Tool | Parameters | Description |
|------|------------|-------------|
| `bash` | `{ command: string }` | Execute shell command |
| `read_file` | `{ path: string }` | Read file contents |
| `write_file` | `{ path: string, content: string }` | Write file |
| `edit_file` | `{ path: string, old_string: string, new_string: string }` | Edit file |

### Agent Loop

For MVP, implement a simple multi-step loop:

1. Send user prompt + tools to OpenAI
2. Stream response, collect tool calls
3. Execute tools locally
4. Feed results back to API
5. Repeat until no more tool calls
6. Return final response

Maximum 5 steps per turn to prevent runaway execution.

### CanonicalEvent Mapping

Map OpenAI events to existing CanonicalEvent schema:

| OpenAI Event | CanonicalEvent |
|--------------|----------------|
| `content_delta` | `text_delta` |
| `tool_call_start` | `tool_start` |
| `tool_call_result` | `tool_result` |
| API error | `error` |

### Configuration

Add new env variables to config.env.example:

```
TL_OPENAI_API_KEY=     # OpenAI API key
TL_OPENAI_MODEL=       # Default model (gpt-4o, gpt-4.1, etc)
TL_RUNTIME=claude      # claude | openai | auto
```

### Runtime Selection Logic

Engine determines provider based on:

1. Per-chat runtime override (from `/runtime` command)
2. Global TL_RUNTIME env setting
3. Default to 'claude' if unset

## Testing

- Unit tests for OpenAIProvider
- Unit tests for tool definitions
- Unit tests for CanonicalEvent mapping
- Integration test: end-to-end IM → OpenAI → IM flow

## Migration & Compatibility

- No breaking changes to existing Claude integration
- `/runtime` command already exists, just extend to support 'openai'
- Sessions are runtime-specific: Claude sessions use ~/.claude, OpenAI has no session persistence (MVP)

## Open Questions

1. **Model selection**: Should we support model-specific overrides per chat? (e.g., `/model gpt-4.1`)
   - Recommendation: Yes, add `/model` command for both providers

2. **Cost tracking**: OpenAI doesn't expose token counts in streaming mode
   - Recommendation: Estimate from response content length, or skip for MVP

3. **System prompt**: Should OpenAI agent use same system prompt as Claude?
   - Recommendation: Start minimal, add project-specific context as needed

## Success Criteria

- User can switch between Claude and OpenAI via `/runtime` command
- OpenAI agent can execute Bash, Read, Write, Edit operations
- Streaming output works with real-time IM updates
- Core test suite passes