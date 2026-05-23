# Testing Guide for TLive

This document summarizes the testing strategy for the Feishu/Lark bridge for Claude Code.

## Current Focus

- `src/channels/feishu/` covers Feishu adapter behavior and card/message rendering.
- `src/providers/` wraps Claude Code SDK sessions and streaming turns.
- `src/server/engine/` owns command routing, session state, permissions, and query orchestration.
- `src/server/mcp/` and `src/server/services/` cover agent callback endpoints and file delivery.

## Harder Areas To Test

### External SDK/API Boundaries

The Feishu adapter depends on platform APIs for message send/edit, reactions, event dispatch, and streaming cards. Prefer narrow mocks around the imported SDK boundary and keep behavior assertions focused on the outgoing API calls.

### Long Dependency Chains

Command handlers and coordinators often depend on session state, permissions, workspace state, and the bridge manager. Keep test fixtures minimal and assert user-visible behavior instead of internal fields.

### Async Streams

`claude-live-session.ts` and streaming card code use async generators, `ReadableStream`, timeouts, and abort signals. Use deterministic fake streams and fake timers where possible.

## Helpers

### `helpers/claude-sdk-mock.ts`

Mock factories for Claude SDK sessions:

```typescript
const session = createMockLiveSession();
```

### `helpers/assertions.ts`

Shared assertion helpers:

```typescript
assertContainsText(text, 'expected');
assertSendSuccess(result, 'msg-123');
assertRateLimitError(error, 60000);
```

## Best Practices

1. Test pure functions first.
2. Mock external dependencies at module boundaries.
3. Assert behavior, not private implementation details.
4. Keep mocks as small as the test allows.
5. Add focused tests for adapter, engine, formatting, and config behavior changes.

## Running Tests

```bash
npm test
npm test -- src/__tests__/providers/claude-sdk.test.ts
npm run test:watch
```
