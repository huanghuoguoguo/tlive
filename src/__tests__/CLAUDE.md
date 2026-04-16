# Testing Guide for TLive

This document explains the testing strategy, coverage challenges, and best practices for adding tests to this project.

## Current Coverage Status

| Metric | Coverage | Target |
|--------|----------|--------|
| Statements | ~60% | 70% |
| Branches | ~52% | 50% |
| Functions | ~61% | 55% |
| Lines | ~61% | 60% |

### High Coverage Modules (>80%)

These modules are well-tested and should be maintained:
- `src/markdown/` - 98%+ (pure text processing)
- `src/permissions/` - 95%+ (authorization logic)
- `src/delivery/` - 87%+ (message chunking)
- `src/engine/tool-registry.ts` - 95%+ (tool management)

### Low Coverage Modules (<30%)

These modules have inherent testing challenges:

| Module | Branch Coverage | Reason |
|--------|-----------------|--------|
| `src/channels/qqbot/adapter.ts` | 8% | WebSocket + API dependencies |
| `src/engine/commands/bash.ts` | 0% | Command handler, requires session state |
| `src/engine/commands/diagnose.ts` | 0% | Depends on engine state |
| `src/engine/automation/streaming.ts` | 0% | Async stream processing |
| `src/channels/feishu/streaming.ts` | 0% | Long-polling stream |
| `src/engine/coordinators/push-handler.ts` | 27% | Webhook push handling |

## Why Some Modules Are Hard to Test

### 1. External SDK/API Dependencies

Modules like `qqbot/adapter.ts`, `telegram/adapter.ts` rely on:
- WebSocket connections (connect, heartbeat, reconnect, disconnect)
- Platform-specific API calls (send message, edit message, reactions)
- Platform-specific message formats

**Challenge**: Mocking full WebSocket lifecycle is complex and can diverge from real behavior.

### 2. Long Dependency Chains

Command handlers depend on multiple state objects:
```
Command → SessionState → PermissionGateway → BridgeManager → WorkspaceState
```

Each command handler requires mocking 5-10 dependencies, making test setup verbose.

### 3. Async Stream Processing

`streaming.ts`, `claude-live-session.ts` use:
- AsyncGenerator patterns
- ReadableStream lifecycle
- Time-based branches (timeout, retry, heartbeat)

**Challenge**: Streams need careful mock construction to simulate real behavior.

### 4. Error Branches

Many error handling branches only trigger in real scenarios:
```typescript
if (error.code === 'ETIMEDOUT') { ... }
if (response.status === 429) { ... }  // rate limit
if (ws.readyState === WebSocket.CLOSING) { ... }
```

**Challenge**: These require精心构造的 mock 错误场景.

## Test Helpers Available

### `helpers/platform-mock.ts`

Mock factories for IM platforms:
```typescript
// Telegram mock
const api = createTelegramApiMocks();
const ctx = createTelegramContext({ userId: 123, text: 'hello' });
mockGrammy(api);

// Feishu mock
const { eventHandlers, mockEventHandler } = mockLarkSuite(createFeishuApiMocks());
```

### `helpers/claude-sdk-mock.ts`

Mock factories for Claude SDK:
```typescript
// Create mock query
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn().mockImplementation(() => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } };
      yield { type: 'result', subtype: 'success' };
    },
  })),
}));

// Mock live session
const session = createMockLiveSession();
```

### `helpers/assertions.ts`

Assertion helpers:
```typescript
assertContainsText(text, 'expected');
assertSendSuccess(result, 'msg-123');
assertRateLimitError(error, 60000);
```

## Best Practices for Adding Tests

### 1. Pure Functions First

Prioritize testing pure logic (no I/O, no state):
```typescript
// Easy to test - pure function
function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

// Test is straightforward
expect(truncate('hello world', 5)).toBe('hello');
```

### 2. Mock at Module Boundary

Mock external dependencies at the import level:
```typescript
// Good: mock at module boundary
vi.mock('grammy', () => ({
  Bot: class MockBot { ... },
}));

// Avoid: mocking internal functions
vi.mock('../../internal/helper.js');
```

### 3. Test Behavior, Not Implementation

Focus on what the code does, not how:
```typescript
// Good: test behavior
it('sends message to chat', async () => {
  await adapter.send({ chatId: '123', text: 'hello' });
  expect(mockSendMessage).toHaveBeenCalledWith('123', 'hello');
});

// Avoid: testing internal state
it('sets internal flag', () => {
  expect(adapter._isConnected).toBe(true);
});
```

### 4. Keep Mocks Minimal

Only mock what's needed for the test:
```typescript
// Good: minimal mock
const mockApi = { sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }) };

// Avoid: over-mocking
const mockApi = {
  sendMessage: vi.fn(),
  editMessage: vi.fn(),
  sendPhoto: vi.fn(),
  ... // 10 more methods not used in test
};
```

### 5. Use Type-Safe Mocks

Leverage TypeScript for mock safety:
```typescript
import type { MockTelegramApi } from '../helpers/platform-mock.js';

const api: MockTelegramApi = createTelegramApiMocks();
// TypeScript ensures all required methods are mocked
```

### 6. Group Related Tests

Use describe blocks for organization:
```typescript
describe('TelegramAdapter', () => {
  describe('send()', () => { ... });
  describe('editMessage()', () => { ... });
  describe('error handling', () => { ... });
});
```

## When to Skip Tests

It's acceptable to have lower coverage for:

1. **Platform adapters** - Integration tests are more valuable than unit tests
2. **Command handlers** - End-to-end tests cover real behavior better
3. **Error branches** - Some only occur in production (rate limits, network issues)
4. **Boilerplate code** - Simple getters/setters don't need tests

## Running Tests

```bash
# Run all tests
npm test

# Run specific file
npm test -- src/__tests__/providers/claude-sdk.test.ts

# Run with coverage
npm run test:coverage

# Watch mode for development
npm run test:watch
```

## Coverage Thresholds

Per-module thresholds are configured in `vitest.config.ts`:
- **Utility modules** (`utils/`, `markdown/`): 70%+ statements
- **Core logic** (`permissions/`, `delivery/`): 60%+ statements
- **Integration layers** (`providers/`, `channels/`): 25%+ statements

These thresholds reflect inherent testability differences between module types.