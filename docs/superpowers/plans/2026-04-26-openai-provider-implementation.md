# Implementation Plan: OpenAI Provider Integration

**Spec:** `docs/superpowers/specs/2026-04-26-openai-provider-design.md`
**Branch:** `feat-openai-provider`

## Overview

Add OpenAI as an alternative AI provider to tlive, enabling `/runtime openai` command.

## Tasks

### Phase 1: OpenAI SDK & Provider Foundation

#### Task 1.1: Add OpenAI SDK dependency
- **File:** `package.json`
- **Action:** Add `"openai": "^4.x"` to dependencies
- **Verify:** `npm install` succeeds

#### Task 1.2: Create OpenAI tool definitions
- **File:** `src/providers/openai-tools.ts` (NEW)
- **Action:** Define OpenAI function tools for Bash, Read, Write, Edit
```typescript
export const OPENAI_TOOLS = [
  { type: 'function', function: { name: 'bash', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'read_file', parameters: { ... } } },
  { type: 'function', function: { name: 'write_file', parameters: { ... } } },
  { type: 'function', function: { name: 'edit_file', parameters: { ... } } },
];
```
- **Verify:** TypeScript compiles, tool schemas valid

#### Task 1.3: Create tool executor
- **File:** `src/providers/openai-tool-executor.ts` (NEW)
- **Action:** Implement local execution of tool calls
```typescript
export async function executeOpenAITool(name: string, input: Record<string, unknown>): Promise<string>
```
- Handles: bash (execSync), read_file (fs.readFile), write_file (fs.writeFile), edit_file (exact string replacement)
- Security: bash timeout 30s, read file size limit 1MB
- **Verify:** Unit tests for each tool pass

#### Task 1.4: Create OpenAI event adapter
- **File:** `src/providers/openai-adapter.ts` (NEW)
- **Action:** Map OpenAI streaming events to CanonicalEvent
```typescript
export class OpenAIAdapter {
  mapStreamEvent(event: OpenAI.StreamEvent): CanonicalEvent[]
}
```
- Maps: content_delta → text_delta, tool_call → tool_start/tool_result
- **Verify:** Unit tests for mapping pass

### Phase 2: OpenAIProvider Implementation

#### Task 2.1: Create OpenAIProvider class
- **File:** `src/providers/openai-provider.ts` (NEW)
- **Action:** Implement provider with streaming + agent loop
```typescript
export class OpenAIProvider {
  streamChat(params: StreamChatParams): StreamChatResult
}
```
- Uses OpenAI SDK chat.completions.stream()
- Agent loop: send prompt → collect tool calls → execute → feed back → repeat (max 5 steps)
- **Verify:** Provider instantiates, API calls work with mock

#### Task 2.2: Create OpenAILiveSession (simplified)
- **File:** `src/providers/openai-live-session.ts` (NEW)
- **Action:** Implement simplified LiveSession for OpenAI
```typescript
export class OpenAILiveSession implements LiveSession {
  startTurn(prompt: string, params?: TurnParams): StreamChatResult
  steerTurn(text: string): void  // MVP: queue for next turn
  interruptTurn(): void
  // isAlive always true for MVP, isTurnActive tracks active stream
}
```
- Note: No persistent session state in MVP (OpenAI has no session resume)
- **Verify:** Session creates, turn starts/stops

#### Task 2.3: Add OpenAI config options
- **File:** `src/config.ts`
- **Action:** Add OpenAI config fields to Config interface
```typescript
openai: {
  apiKey: string;
  model: string;
}
```
- Add parsing for `TL_OPENAI_API_KEY`, `TL_OPENAI_MODEL`
- **File:** `config.env.example`, `.claude/skills/tlive/references/config.env.example`
- **Action:** Add example config entries
- **Verify:** Config loads with new fields

### Phase 3: Runtime Selection

#### Task 3.1: Create provider factory
- **File:** `src/providers/index.ts` (NEW or modify existing)
- **Action:** Export provider factory function
```typescript
export function createProvider(runtime: 'claude' | 'openai', config: Config): ClaudeSDKProvider | OpenAIProvider
```
- **Verify:** Factory returns correct provider type

#### Task 3.2: Add runtime to session state
- **File:** `src/store/interface.ts`
- **Action:** Add `runtime?: 'claude' | 'openai'` to ChannelBinding
- **File:** `src/engine/state/session-state.ts`
- **Action:** Track per-chat runtime preference
- **Verify:** Runtime persists across restarts

#### Task 3.3: Implement `/runtime` command
- **File:** `src/engine/commands/runtime.ts` (NEW)
- **Action:** Create command handler
```typescript
export const runtimeCommand: CommandHandler = {
  name: '/runtime',
  execute(ctx) {
    // Parse 'claude' or 'openai'
    // Update session state
    // Return confirmation message
  }
}
```
- **File:** `src/engine/commands/index.ts`
- **Action:** Register command
- **Verify:** `/runtime openai` updates state, `/runtime claude` reverts

### Phase 4: Engine Integration

#### Task 4.1: Update SDKEngine for multi-provider
- **File:** `src/engine/sdk/engine.ts`
- **Action:** Accept provider type in getOrCreateSession
- Change signature to accept either ClaudeSDKProvider or OpenAIProvider
- **Verify:** Engine works with both providers

#### Task 4.2: Update BridgeFactory
- **File:** `src/engine/bridge-factory.ts`
- **Action:** Create both providers, use factory for selection
```typescript
const claudeProvider = new ClaudeSDKProvider(...);
const openaiProvider = config.openai.apiKey ? new OpenAIProvider(...) : undefined;
```
- **Verify:** Bridge starts with both providers available

#### Task 4.3: Update QueryOrchestrator
- **File:** `src/engine/coordinators/query.ts`
- **Action:** Route to correct provider based on runtime setting
- **Verify:** Query uses correct provider

### Phase 5: Testing & Polish

#### Task 5.1: Unit tests for OpenAIProvider
- **File:** `src/__tests__/providers/openai-provider.test.ts` (NEW)
- **Action:** Test provider creation, streaming, tool loop
- **Verify:** Tests pass

#### Task 5.2: Unit tests for tool executor
- **File:** `src/__tests__/providers/openai-tool-executor.test.ts` (NEW)
- **Action:** Test each tool execution
- **Verify:** Tests pass

#### Task 5.3: Integration test
- **Action:** Manual test with real OpenAI API
- Send message via IM, verify streaming output
- Test Bash/Read/Write/Edit tool execution
- **Verify:** End-to-end flow works

#### Task 5.4: Update documentation
- **File:** `README.md`, `README_CN.md`
- **Action:** Document OpenAI support, config options
- **Verify:** Docs accurate

## Risk Mitigation

1. **OpenAI API key required:** Gracefully handle missing key, show error in IM
2. **Tool execution security:** Bash timeout, file size limits
3. **Streaming reliability:** Handle API disconnects, retry logic

## Success Verification

- [ ] `tlive start --runtime openai` works
- [ ] `/runtime openai` command in IM switches provider
- [ ] OpenAI agent executes Bash, Read, Write, Edit
- [ ] Streaming output shows in IM
- [ ] All tests pass: `npm run check`