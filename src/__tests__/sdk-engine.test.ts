import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SDKEngine } from '../engine/sdk-engine.js';
import type { LiveSession, LLMProvider } from '../providers/base.js';

function createMockSession(isAlive = true, isTurnActive = false): LiveSession {
  let callbacks: { onTurnComplete?: () => void } | undefined;
  return {
    isAlive,
    isTurnActive,
    startTurn: vi.fn().mockReturnValue({ stream: new ReadableStream() }),
    steerTurn: vi.fn(),
    sendWithPriority: vi.fn().mockResolvedValue(undefined),
    interruptTurn: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    setLifecycleCallbacks: vi.fn().mockImplementation((nextCallbacks: { onTurnComplete?: () => void }) => {
      callbacks = nextCallbacks;
    }),
    __triggerTurnComplete: () => callbacks?.onTurnComplete?.(),
  } as unknown as LiveSession;
}

function createMockProvider(sessions: Record<string, LiveSession> = {}): LLMProvider {
  return {
    streamChat: vi.fn().mockReturnValue({ stream: new ReadableStream() }),
    capabilities: vi.fn().mockReturnValue({ slashCommands: true, askUserQuestion: true, liveSession: true, todoTracking: true, costInUsd: true, skills: true, sessionResume: true }),
    createSession: vi.fn().mockImplementation((params) => {
      const key = `${params.workingDirectory}`;
      return sessions[key] ?? createMockSession();
    }),
  } as unknown as LLMProvider;
}

describe('SDKEngine', () => {
  let engine: SDKEngine;

  beforeEach(() => {
    engine = new SDKEngine();
  });

  describe('Queue Depth Management', () => {
    it('starts with queue depth 0', () => {
      expect(engine.getQueueDepth('test-session')).toBe(0);
    });

    it('reports queue as not full when depth is 0', () => {
      expect(engine.isQueueFull('test-session')).toBe(false);
    });

    it('default max queue depth is 3', () => {
      expect(engine.getMaxQueueDepth()).toBe(3);
    });

    it('decrements queue depth when called', () => {
      // Simulate queue depth being set
      engine.decrementQueueDepth('test-session'); // No effect when depth is 0
      expect(engine.getQueueDepth('test-session')).toBe(0);
    });
  });

  describe('sendWithContext', () => {
    it('returns none mode when no session found', async () => {
      const result = await engine.sendWithContext('telegram', 'chat-1', 'test message');
      expect(result.sent).toBe(false);
      expect(result.mode).toBe('none');
      expect(result.failureReason).toBe('no_session');
    });

    it('does not fall back when reply target is missing', async () => {
      const mockSession = createMockSession(true, true);
      const mockProvider = createMockProvider({ '/workdir': mockSession });

      engine.getOrCreateSession(mockProvider, 'telegram', 'chat-1', '/workdir');

      const result = await engine.sendWithContext('telegram', 'chat-1', 'reply message', 'missing-bubble');
      expect(result).toMatchObject({
        sent: false,
        mode: 'none',
        failureReason: 'reply_target_missing',
      });
      expect(mockSession.sendWithPriority).not.toHaveBeenCalled();
    });

    it('queues message when session exists but turn is not active', async () => {
      const mockSession = createMockSession(true, false);
      const mockProvider = createMockProvider({ '/workdir': mockSession });

      // Create session first
      engine.getOrCreateSession(mockProvider, 'telegram', 'chat-1', '/workdir');

      const result = await engine.sendWithContext('telegram', 'chat-1', 'queued message');

      expect(result.sent).toBe(true);
      expect(result.mode).toBe('queue');
      expect(result.queuePosition).toBe(1);
      expect(result.queueDepth).toBe(1);
      expect(result.maxQueueDepth).toBe(3);
      expect(result.sessionKey).toBe('telegram:chat-1:/workdir');
      expect(mockSession.sendWithPriority).toHaveBeenCalledWith('queued message', 'later');
    });

    it('increments queue position for subsequent queue operations', async () => {
      const mockSession = createMockSession(true, false);
      const mockProvider = createMockProvider({ '/workdir': mockSession });

      engine.getOrCreateSession(mockProvider, 'telegram', 'chat-1', '/workdir');

      const result1 = await engine.sendWithContext('telegram', 'chat-1', 'message 1');
      const result2 = await engine.sendWithContext('telegram', 'chat-1', 'message 2');
      const result3 = await engine.sendWithContext('telegram', 'chat-1', 'message 3');

      expect(result1.queuePosition).toBe(1);
      expect(result2.queuePosition).toBe(2);
      expect(result3.queuePosition).toBe(3);
    });

    it('rejects message when queue is full (depth >= 3)', async () => {
      const mockSession = createMockSession(true, false);
      const mockProvider = createMockProvider({ '/workdir': mockSession });

      engine.getOrCreateSession(mockProvider, 'telegram', 'chat-1', '/workdir');

      // Fill the queue
      await engine.sendWithContext('telegram', 'chat-1', 'message 1');
      await engine.sendWithContext('telegram', 'chat-1', 'message 2');
      await engine.sendWithContext('telegram', 'chat-1', 'message 3');

      // Fourth message should be rejected
      const result = await engine.sendWithContext('telegram', 'chat-1', 'message 4');

      expect(result.sent).toBe(false);
      expect(result.mode).toBe('queue');
      expect(result.queueFull).toBe(true);
      expect(result.queueDepth).toBe(3);
      expect(result.maxQueueDepth).toBe(3);
    });

    it('steers message when session has active turn', async () => {
      const mockSession = createMockSession(true, true);
      const mockProvider = createMockProvider({ '/workdir': mockSession });

      engine.getOrCreateSession(mockProvider, 'telegram', 'chat-1', '/workdir');

      const result = await engine.sendWithContext('telegram', 'chat-1', 'steer message');

      expect(result.sent).toBe(true);
      expect(result.mode).toBe('steer');
      expect(result.queuePosition).toBeUndefined();
      expect(mockSession.sendWithPriority).toHaveBeenCalledWith('steer message', 'now');
    });

    it('returns send_failed when steering cannot be injected', async () => {
      const mockSession = createMockSession(true, true);
      vi.mocked(mockSession.sendWithPriority).mockRejectedValueOnce(new Error('boom'));
      const mockProvider = createMockProvider({ '/workdir': mockSession });

      engine.getOrCreateSession(mockProvider, 'telegram', 'chat-1', '/workdir');

      const result = await engine.sendWithContext('telegram', 'chat-1', 'steer message');
      expect(result).toMatchObject({
        sent: false,
        mode: 'none',
        failureReason: 'send_failed',
        sessionKey: 'telegram:chat-1:/workdir',
      });
    });

    it('steering does not increment queue depth', async () => {
      const mockSession = createMockSession(true, true);
      const mockProvider = createMockProvider({ '/workdir': mockSession });

      engine.getOrCreateSession(mockProvider, 'telegram', 'chat-1', '/workdir');

      await engine.sendWithContext('telegram', 'chat-1', 'steer 1');
      await engine.sendWithContext('telegram', 'chat-1', 'steer 2');

      const sessionKey = 'telegram:chat-1:/workdir';
      expect(engine.getQueueDepth(sessionKey)).toBe(0);
    });

    it('cleans up queue depth when session is closed', async () => {
      const mockSession = createMockSession(true, false);
      const mockProvider = createMockProvider({ '/workdir': mockSession });

      engine.getOrCreateSession(mockProvider, 'telegram', 'chat-1', '/workdir');
      await engine.sendWithContext('telegram', 'chat-1', 'queued');

      const sessionKey = 'telegram:chat-1:/workdir';
      expect(engine.getQueueDepth(sessionKey)).toBe(1);

      engine.closeSession('telegram', 'chat-1', '/workdir');
      expect(engine.getQueueDepth(sessionKey)).toBe(0);
    });

    it('cleans up queue depth when all sessions for chat are closed', async () => {
      const mockSession = createMockSession(true, false);
      const mockProvider = createMockProvider({ '/workdir': mockSession });

      engine.getOrCreateSession(mockProvider, 'telegram', 'chat-1', '/workdir');
      await engine.sendWithContext('telegram', 'chat-1', 'queued');

      engine.closeSession('telegram', 'chat-1'); // Close all sessions for chat
      expect(engine.getQueueDepth('telegram:chat-1:/workdir')).toBe(0);
    });

    it('decrements queue depth as queued turns are consumed', async () => {
      const mockSession = createMockSession(true, false) as LiveSession & { __triggerTurnComplete: () => void };
      const mockProvider = createMockProvider({ '/workdir': mockSession });

      engine.getOrCreateSession(mockProvider, 'telegram', 'chat-1', '/workdir');
      await engine.sendWithContext('telegram', 'chat-1', 'message 1');
      await engine.sendWithContext('telegram', 'chat-1', 'message 2');

      mockSession.__triggerTurnComplete();
      expect(engine.getQueueDepth('telegram:chat-1:/workdir')).toBe(1);

      mockSession.__triggerTurnComplete();
      expect(engine.getQueueDepth('telegram:chat-1:/workdir')).toBe(0);
    });
  });

  describe('getOrCreateSession', () => {
    it('creates new session when none exists', () => {
      const mockSession = createMockSession();
      const mockProvider = createMockProvider({ '/workdir': mockSession });

      const session = engine.getOrCreateSession(mockProvider, 'telegram', 'chat-1', '/workdir');

      expect(session).toBeDefined();
      expect(mockProvider.createSession).toHaveBeenCalled();
    });

    it('returns existing session if alive', () => {
      const mockSession = createMockSession(true, false);
      const mockProvider = createMockProvider({ '/workdir': mockSession });

      engine.getOrCreateSession(mockProvider, 'telegram', 'chat-1', '/workdir');
      engine.getOrCreateSession(mockProvider, 'telegram', 'chat-1', '/workdir');

      expect(mockProvider.createSession).toHaveBeenCalledTimes(1);
    });
  });
});
