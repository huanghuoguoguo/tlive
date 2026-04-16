/**
 * Mock factory for Claude Agent SDK and live session provider.
 * Enables deterministic testing of provider logic without real Claude calls.
 */

import { vi } from 'vitest';
import type { CanonicalEvent } from '../../canonical/schema.js';

// ── Mock SDK Message Types ──

export interface MockSdkMessage {
  type: 'result' | 'stream_event' | 'assistant' | 'user';
  subtype?: string;
  message?: unknown;
  content?: unknown;
  num_turns?: number;
}

export interface MockSdkResult {
  subtype: 'success' | 'error';
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  error_message?: string;
}

export interface MockSdkStreamEvent {
  subtype: 'content_block_delta' | 'content_block_start' | 'content_block_stop';
  index?: number;
  delta?: { type: string; text?: string; thinking?: string };
  content_block?: { type: string; text?: string; name?: string; id?: string };
}

// ── Mock Query Factory ──

export interface MockQueryOptions {
  messages?: MockSdkMessage[];
  error?: Error;
  delay?: number;
}

/**
 * Create a mock query() generator that yields predefined messages.
 */
export function createMockQuery(options: MockQueryOptions = {}): () => AsyncGenerator<MockSdkMessage> {
  const messages = options.messages ?? [
    { type: 'stream_event', subtype: 'content_block_start', content_block: { type: 'text', id: 'msg-1' } },
    { type: 'stream_event', subtype: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
    { type: 'stream_event', subtype: 'content_block_stop' },
    { type: 'result', subtype: 'success', result: 'Done', total_cost_usd: 0.01 },
  ];

  return async function* mockQuery() {
    if (options.error) {
      throw options.error;
    }

    for (const msg of messages) {
      if (options.delay) {
        await new Promise(resolve => setTimeout(resolve, options.delay));
      }
      yield msg as MockSdkMessage;
    }
  };
}

/**
 * Create mock SDK events for text delta streaming.
 */
export function createTextDeltaEvents(text: string): MockSdkMessage[] {
  return [
    { type: 'stream_event', subtype: 'content_block_start', content_block: { type: 'text', id: 'msg-1' } },
    { type: 'stream_event', subtype: 'content_block_delta', delta: { type: 'text_delta', text } },
    { type: 'stream_event', subtype: 'content_block_stop' },
    { type: 'result', subtype: 'success', result: text, total_cost_usd: 0.01 },
  ];
}

/**
 * Create mock SDK events for thinking + text response.
 */
export function createThinkingThenTextEvents(thinking: string, text: string): MockSdkMessage[] {
  return [
    { type: 'stream_event', subtype: 'content_block_start', content_block: { type: 'thinking', id: 'think-1' } },
    { type: 'stream_event', subtype: 'content_block_delta', delta: { type: 'thinking_delta', thinking } },
    { type: 'stream_event', subtype: 'content_block_stop' },
    { type: 'stream_event', subtype: 'content_block_start', content_block: { type: 'text', id: 'msg-1' } },
    { type: 'stream_event', subtype: 'content_block_delta', delta: { type: 'text_delta', text } },
    { type: 'stream_event', subtype: 'content_block_stop' },
    { type: 'result', subtype: 'success', result: text, total_cost_usd: 0.02 },
  ];
}

/**
 * Create mock SDK events for tool use.
 */
export function createToolUseEvents(toolName: string, toolInput: Record<string, unknown>, toolResult: string): MockSdkMessage[] {
  return [
    { type: 'stream_event', subtype: 'content_block_start', content_block: { type: 'tool_use', name: toolName, id: 'tool-1' } },
    { type: 'stream_event', subtype: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolInput) } },
    { type: 'stream_event', subtype: 'content_block_stop' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: toolName, id: 'tool-1', input: toolInput }] } },
    { type: 'stream_event', subtype: 'content_block_start', content_block: { type: 'tool_result', tool_use_id: 'tool-1' } },
    { type: 'stream_event', subtype: 'content_block_delta', delta: { type: 'text_delta', text: toolResult } },
    { type: 'stream_event', subtype: 'content_block_stop' },
    { type: 'result', subtype: 'success', result: 'Tool executed', total_cost_usd: 0.01 },
  ];
}

/**
 * Create mock SDK result for error.
 */
export function createErrorResult(errorMessage: string): MockSdkMessage[] {
  return [
    { type: 'result', subtype: 'error', is_error: true, error_message: errorMessage },
  ];
}

// ── Mock ClaudeAdapter Output ──

/**
 * Create canonical events for testing the adapter output.
 */
export function createCanonicalEvents(kind: 'text' | 'thinking' | 'error' | 'result', content: string, meta?: Record<string, unknown>): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];

  switch (kind) {
    case 'text':
      events.push({ kind: 'text_delta', text: content });
      break;
    case 'thinking':
      events.push({ kind: 'thinking_delta', text: content });
      break;
    case 'error':
      events.push({ kind: 'error', message: content });
      break;
    case 'result':
      events.push({ kind: 'query_result', text: content, ...(meta ?? {}) });
      break;
  }

  return events;
}

// ── SDK Module Mock ──

export interface MockSdkApi {
  query: ReturnType<typeof vi.fn>;
  canUseToolCalls: unknown[];
}

/**
 * Mock the @anthropic-ai/claude-agent-sdk module.
 */
export function mockClaudeAgentSdk(options: MockQueryOptions = {}): MockSdkApi {
  const canUseToolCalls: unknown[] = [];
  const mockQueryFn = vi.fn().mockImplementation(() => createMockQuery(options)());

  vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
    query: mockQueryFn,
  }));

  return { query: mockQueryFn, canUseToolCalls };
}

/**
 * Mock provider module boundary - replaces provider imports with mocks.
 */
export function mockProviderModule(): void {
  vi.mock('../../providers/claude-sdk.js', () => ({
    ClaudeSDKProvider: vi.fn().mockImplementation(() => ({
      streamChat: vi.fn().mockReturnValue({
        stream: new ReadableStream<CanonicalEvent>({
          start(controller) {
            controller.enqueue({ kind: 'text_delta', text: 'mock response' });
            controller.enqueue({ kind: 'query_result', text: 'done' });
            controller.close();
          },
        }),
        controls: undefined,
      }),
      createSession: vi.fn(),
      getDefaultSettingSources: vi.fn().mockReturnValue(['user']),
    })),
  }));
}

// ── Session Lifecycle Mock ──

export interface MockLiveSession {
  _isAlive: boolean;
  _isTurnActive: boolean;
  startTurn: ReturnType<typeof vi.fn>;
  steerTurn: ReturnType<typeof vi.fn>;
  interruptTurn: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

/**
 * Create a mock LiveSession for testing session managers.
 */
export function createMockLiveSession(): MockLiveSession {
  return {
    _isAlive: true,
    _isTurnActive: false,
    startTurn: vi.fn().mockImplementation((prompt: string) => ({
      stream: new ReadableStream<CanonicalEvent>({
        start(controller) {
          controller.enqueue({ kind: 'text_delta', text: 'response to: ' + prompt });
          controller.enqueue({ kind: 'query_result', text: 'done' });
          controller.close();
        },
      }),
      controls: { interrupt: vi.fn(), stopTask: vi.fn() },
    })),
    steerTurn: vi.fn(),
    interruptTurn: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

// ── Permission Handler Mock ──

export type MockPermissionDecision = 'allow' | 'deny' | 'allow_always';

/**
 * Create a mock permission handler that returns specified decisions.
 */
export function createMockPermissionHandler(decisions: MockPermissionDecision[] = ['allow']): ReturnType<typeof vi.fn> {
  let index = 0;
  return vi.fn().mockImplementation(() => {
    const decision = decisions[index % decisions.length];
    index++;
    return decision;
  });
}

// ── Assertion Helpers for Provider Tests ──

/**
 * Collect all events from a stream for testing.
 */
export async function collectStreamEvents(stream: ReadableStream<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    events.push(value);
  }
  return events;
}

/**
 * Assert stream contains expected event types in order.
 */
export function assertEventSequence(events: CanonicalEvent[], expectedKinds: string[]): void {
  const actualKinds = events.map(e => e.kind);
  expect(actualKinds).toEqual(expectedKinds);
}

/**
 * Get text content from text_delta events.
 */
export function getTextFromEvents(events: CanonicalEvent[]): string {
  return events
    .filter(e => e.kind === 'text_delta')
    .map(e => (e as { kind: 'text_delta'; text: string }).text)
    .join('');
}

// Import expect from vitest for assertions
import { expect } from 'vitest';