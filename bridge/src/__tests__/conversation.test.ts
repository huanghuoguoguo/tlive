import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationEngine } from '../engine/conversation.js';
import { initBridgeContext } from '../context.js';
import type { CanonicalEvent } from '../messages/schema.js';

// Mock store
function createMockStore() {
  return {
    acquireLock: vi.fn().mockResolvedValue(true),
    renewLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
    getBinding: vi.fn(), saveBinding: vi.fn(), deleteBinding: vi.fn(), listBindings: vi.fn(),
    isDuplicate: vi.fn(), markProcessed: vi.fn(),
  };
}

// Mock LLM that emits controlled CanonicalEvent objects
function createMockLLM(events: CanonicalEvent[]) {
  return {
    streamChat: () => ({
      stream: new ReadableStream<CanonicalEvent>({
        start(controller) {
          for (const event of events) {
            controller.enqueue(event);
          }
          controller.close();
        }
      }),
      controls: undefined,
    })
  };
}

describe('ConversationEngine', () => {
  let engine: ConversationEngine;
  let mockStore: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    mockStore = createMockStore();
    const mockLLM = createMockLLM([
      { kind: 'text_delta', text: 'Hello ' },
      { kind: 'text_delta', text: 'world' },
      { kind: 'query_result', sessionId: 's1', isError: false, usage: { inputTokens: 10, outputTokens: 5 } },
    ]);

    initBridgeContext({
      defaultWorkdir: '/tmp',
      store: mockStore as any,
      llm: mockLLM as any,
      core: null,
    });

    engine = new ConversationEngine(mockStore as any, mockLLM as any);
  });

  it('processes message and returns full response', async () => {
    const result = await engine.processMessage({
      sdkSessionId: 's1',
      workingDirectory: '/tmp',
      text: 'hi',
    });
    expect(result.text).toBe('Hello world');
  });

  it('acquires and releases session lock', async () => {
    await engine.processMessage({ sdkSessionId: 's1', workingDirectory: '/tmp', text: 'hi' });
    expect(mockStore.acquireLock).toHaveBeenCalledWith('session:s1', expect.any(Number));
    expect(mockStore.releaseLock).toHaveBeenCalledWith('session:s1');
  });

  it('calls onTextDelta for streaming', async () => {
    const deltas: string[] = [];
    await engine.processMessage({
      sdkSessionId: 's1',
      workingDirectory: '/tmp',
      text: 'hi',
      onTextDelta: (d) => deltas.push(d),
    });
    expect(deltas).toEqual(['Hello ', 'world']);
  });

  it('calls onQueryResult with usage', async () => {
    let resultData: any;
    await engine.processMessage({
      sdkSessionId: 's1',
      workingDirectory: '/tmp',
      text: 'hi',
      onQueryResult: (r) => { resultData = r; },
    });
    expect(resultData.usage.inputTokens).toBe(10);
  });

  it('calls onSdkSessionId when SDK returns sessionId', async () => {
    let capturedId: string | undefined;
    await engine.processMessage({
      sdkSessionId: 's1',
      workingDirectory: '/tmp',
      text: 'hi',
      onSdkSessionId: (id) => { capturedId = id; },
    });
    expect(capturedId).toBe('s1');
  });

  it('releases lock even on error', async () => {
    const errorLLM = {
      streamChat: () => ({
        stream: new ReadableStream<CanonicalEvent>({
          start(controller) {
            controller.enqueue({ kind: 'error', message: 'boom' });
            controller.close();
          }
        }),
        controls: undefined,
      })
    };
    initBridgeContext({ defaultWorkdir: '/tmp', store: mockStore as any, llm: errorLLM as any, core: null });
    engine = new ConversationEngine(mockStore as any, errorLLM as any);

    await engine.processMessage({ sdkSessionId: 's1', workingDirectory: '/tmp', text: 'hi' });
    expect(mockStore.releaseLock).toHaveBeenCalled();
  });
});
