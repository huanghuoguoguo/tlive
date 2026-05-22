import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SDKEngine } from '../../engine/sdk/engine.js';
import type { LiveSession } from '../../providers/base.js';
import type { ClaudeSDKProvider } from '../../providers/claude-sdk.js';

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

function createMockProvider(sessions: Record<string, LiveSession> = {}): ClaudeSDKProvider {
  return {
    streamChat: vi.fn().mockReturnValue({ stream: new ReadableStream() }),
    createSession: vi.fn().mockImplementation((params) => {
      const key = `${params.workingDirectory}`;
      return sessions[key] ?? createMockSession();
    }),
  } as unknown as ClaudeSDKProvider;
}

const DEFAULT_SESSION_ID = 'session-1';
const DEFAULT_SESSION_KEY = `feishu:chat-1:${DEFAULT_SESSION_ID}`;

function queueDepth(engine: SDKEngine, sessionKey: string): number {
  return engine.getQueueInfo(sessionKey)?.depth ?? 0;
}

function createEngineSession(
  engine: SDKEngine,
  provider: ClaudeSDKProvider,
  options?: Parameters<SDKEngine['getOrCreateSession']>[1]['options'],
): LiveSession | undefined {
  return engine.getOrCreateSession(provider, {
    channelType: 'feishu',
    chatId: 'chat-1',
    bindingSessionId: DEFAULT_SESSION_ID,
    workdir: '/workdir',
    options,
  });
}

describe('SDKEngine', () => {
  let engine: SDKEngine;

  beforeEach(() => {
    engine = new SDKEngine();
  });

  describe('sendWithContext', () => {
    it('returns none mode when no session found', async () => {
      const result = await engine.sendWithContext('feishu', 'chat-1', 'test message');
      expect(result.sent).toBe(false);
      expect(result.mode).toBe('none');
      expect(result.failureReason).toBe('no_session');
    });

    it('does not fall back when reply target is missing', async () => {
      const mockSession = createMockSession(true, true);
      const mockProvider = createMockProvider({ '/workdir': mockSession });

      createEngineSession(engine, mockProvider);

      const result = await engine.sendWithContext('feishu', 'chat-1', 'reply message', 'missing-bubble');
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
      createEngineSession(engine, mockProvider);

      const result = await engine.sendWithContext('feishu', 'chat-1', 'queued message');

      expect(result.sent).toBe(true);
      expect(result.mode).toBe('queue');
      expect(result.queuePosition).toBe(1);
      expect(result.queueDepth).toBe(1);
      expect(result.maxQueueDepth).toBe(3);
      expect(result.sessionKey).toBe(DEFAULT_SESSION_KEY);
      expect(mockSession.sendWithPriority).toHaveBeenCalledWith('queued message', 'later');
    });

    it('increments queue position for subsequent queue operations', async () => {
      const mockSession = createMockSession(true, false);
      const mockProvider = createMockProvider({ '/workdir': mockSession });

      createEngineSession(engine, mockProvider);

      const result1 = await engine.sendWithContext('feishu', 'chat-1', 'message 1');
      const result2 = await engine.sendWithContext('feishu', 'chat-1', 'message 2');
      const result3 = await engine.sendWithContext('feishu', 'chat-1', 'message 3');

      expect(result1.queuePosition).toBe(1);
      expect(result2.queuePosition).toBe(2);
      expect(result3.queuePosition).toBe(3);
    });

    it('rejects message when queue is full (depth >= 3)', async () => {
      const mockSession = createMockSession(true, false);
      const mockProvider = createMockProvider({ '/workdir': mockSession });

      createEngineSession(engine, mockProvider);

      // Fill the queue
      await engine.sendWithContext('feishu', 'chat-1', 'message 1');
      await engine.sendWithContext('feishu', 'chat-1', 'message 2');
      await engine.sendWithContext('feishu', 'chat-1', 'message 3');

      // Fourth message should be rejected
      const result = await engine.sendWithContext('feishu', 'chat-1', 'message 4');

      expect(result.sent).toBe(false);
      expect(result.mode).toBe('queue');
      expect(result.queueFull).toBe(true);
      expect(result.queueDepth).toBe(3);
      expect(result.maxQueueDepth).toBe(3);
    });

    it('steers message when session has active turn', async () => {
      const mockSession = createMockSession(true, true);
      const mockProvider = createMockProvider({ '/workdir': mockSession });

      createEngineSession(engine, mockProvider);

      const result = await engine.sendWithContext('feishu', 'chat-1', 'steer message');

      expect(result.sent).toBe(true);
      expect(result.mode).toBe('steer');
      expect(result.queuePosition).toBeUndefined();
      expect(mockSession.sendWithPriority).toHaveBeenCalledWith('steer message', 'now');
    });

    it('rejects active-turn injection when provider has no native steer or queue', async () => {
      const mockSession = {
        ...createMockSession(true, true),
        capabilities: { nativeSteer: false, nativeQueue: false },
      } as LiveSession;
      const mockProvider = createMockProvider({ '/workdir': mockSession });

      createEngineSession(engine, mockProvider);

      const result = await engine.sendWithContext('feishu', 'chat-1', 'follow-up');

      expect(result).toMatchObject({
        sent: false,
        mode: 'none',
        failureReason: 'busy_unsupported',
        sessionKey: DEFAULT_SESSION_KEY,
      });
      expect(mockSession.sendWithPriority).not.toHaveBeenCalled();
    });

    it('returns send_failed when steering cannot be injected', async () => {
      const mockSession = createMockSession(true, true);
      vi.mocked(mockSession.sendWithPriority).mockRejectedValueOnce(new Error('boom'));
      const mockProvider = createMockProvider({ '/workdir': mockSession });

      createEngineSession(engine, mockProvider);

      const result = await engine.sendWithContext('feishu', 'chat-1', 'steer message');
      expect(result).toMatchObject({
        sent: false,
        mode: 'none',
        failureReason: 'send_failed',
        sessionKey: DEFAULT_SESSION_KEY,
      });
    });

    it('steering does not increment queue depth', async () => {
      const mockSession = createMockSession(true, true);
      const mockProvider = createMockProvider({ '/workdir': mockSession });

      createEngineSession(engine, mockProvider);

      await engine.sendWithContext('feishu', 'chat-1', 'steer 1');
      await engine.sendWithContext('feishu', 'chat-1', 'steer 2');

      const sessionKey = DEFAULT_SESSION_KEY;
      expect(queueDepth(engine, sessionKey)).toBe(0);
    });

    it('cleans up queue depth when session is closed', async () => {
      const mockSession = createMockSession(true, false);
      const mockProvider = createMockProvider({ '/workdir': mockSession });

      createEngineSession(engine, mockProvider);
      await engine.sendWithContext('feishu', 'chat-1', 'queued');

      const sessionKey = DEFAULT_SESSION_KEY;
      expect(queueDepth(engine, sessionKey)).toBe(1);

      engine.closeSession('feishu', 'chat-1', '/workdir');
      expect(queueDepth(engine, sessionKey)).toBe(0);
    });

    it('cleans up queue depth when all sessions for chat are closed', async () => {
      const mockSession = createMockSession(true, false);
      const mockProvider = createMockProvider({ '/workdir': mockSession });

      createEngineSession(engine, mockProvider);
      await engine.sendWithContext('feishu', 'chat-1', 'queued');

      engine.closeSession('feishu', 'chat-1'); // Close all sessions for chat
      expect(queueDepth(engine, DEFAULT_SESSION_KEY)).toBe(0);
    });

    it('decrements queue depth as queued turns are consumed', async () => {
      const mockSession = createMockSession(true, false) as LiveSession & { __triggerTurnComplete: () => void };
      const mockProvider = createMockProvider({ '/workdir': mockSession });

      createEngineSession(engine, mockProvider);
      await engine.sendWithContext('feishu', 'chat-1', 'message 1');
      await engine.sendWithContext('feishu', 'chat-1', 'message 2');

      mockSession.__triggerTurnComplete();
      expect(queueDepth(engine, DEFAULT_SESSION_KEY)).toBe(1);

      mockSession.__triggerTurnComplete();
      expect(queueDepth(engine, DEFAULT_SESSION_KEY)).toBe(0);
    });
  });

  describe('getOrCreateSession', () => {
    it('creates new session when none exists', () => {
      const mockSession = createMockSession();
      const mockProvider = createMockProvider({ '/workdir': mockSession });

      const session = createEngineSession(engine, mockProvider);

      expect(session).toBe(mockSession);
      expect(mockProvider.createSession).toHaveBeenCalledWith(expect.objectContaining({
        workingDirectory: '/workdir',
      }));
      expect(engine.getActiveSessionKey('feishu', 'chat-1')).toBe(DEFAULT_SESSION_KEY);
      expect(engine.hasActiveSession('feishu', 'chat-1', '/workdir')).toBe(true);
      expect(engine.getSessionsForChat('feishu', 'chat-1')).toMatchObject([
        {
          sessionKey: DEFAULT_SESSION_KEY,
          workdir: '/workdir',
          isAlive: true,
          isTurnActive: false,
          bindingSessionId: DEFAULT_SESSION_ID,
          isCurrent: true,
        },
      ]);
    });

    it('returns existing session if alive', () => {
      const mockSession = createMockSession(true, false);
      const mockProvider = createMockProvider({ '/workdir': mockSession });

      createEngineSession(engine, mockProvider);
      createEngineSession(engine, mockProvider);

      expect(mockProvider.createSession).toHaveBeenCalledTimes(1);
    });

    it('recreates an alive session when a resume session id is selected later', () => {
      const firstSession = createMockSession(true, false);
      const secondSession = createMockSession(true, false);
      const provider = {
        streamChat: vi.fn().mockReturnValue({ stream: new ReadableStream() }),
        createSession: vi
          .fn()
          .mockReturnValueOnce(firstSession)
          .mockReturnValueOnce(secondSession),
      } as unknown as ClaudeSDKProvider;

      createEngineSession(engine, provider);
      const recreated = createEngineSession(engine, provider, {
        sessionId: 'sdk-existing',
      });

      expect(recreated).toBe(secondSession);
      expect(firstSession.close).toHaveBeenCalled();
      expect(provider.createSession).toHaveBeenLastCalledWith(expect.objectContaining({
        sessionId: 'sdk-existing',
      }));
    });

    it('preserves reply routing after runtime reset and recreates the live session on demand', () => {
      const firstSession = createMockSession(true, false);
      const secondSession = createMockSession(true, false);
      const provider = {
        streamChat: vi.fn().mockReturnValue({ stream: new ReadableStream() }),
        createSession: vi
          .fn()
          .mockReturnValueOnce(firstSession)
          .mockReturnValueOnce(secondSession),
      } as unknown as ClaudeSDKProvider;

      createEngineSession(engine, provider);
      engine.setActiveMessageId('feishu:chat-1', 'bubble-1', 'feishu:chat-1:session-1');

      engine.resetSessionRuntime('feishu:chat-1:session-1', 'expire');

      expect(engine.getSessionForBubble('bubble-1')).toBe('feishu:chat-1:session-1');
      expect(engine.hasActiveSession('feishu', 'chat-1', '/workdir')).toBe(false);

      const recreated = createEngineSession(engine, provider);
      expect(recreated).toBe(secondSession);
      expect(provider.createSession).toHaveBeenCalledTimes(2);
    });

    it('moves a session from main chat scope to a topic scope', async () => {
      const mockSession = createMockSession(true, false);
      const provider = createMockProvider({ '/workdir': mockSession });

      createEngineSession(engine, provider);
      engine.setActiveMessageId('feishu:chat-1', 'bubble-1', 'feishu:chat-1:session-1');
      await engine.sendWithContext('feishu', 'chat-1', 'queued before move');

      const newKey = engine.moveSessionToChat('feishu:chat-1:session-1', 'chat-1#thread:thread-1');

      expect(newKey).toBe('feishu:chat-1#thread:thread-1:session-1');
      expect(engine.getSessionForBubble('bubble-1')).toBe(newKey);
      expect(engine.getActiveSessionKey('feishu', 'chat-1')).toBeUndefined();
      expect(engine.getActiveSessionKey('feishu', 'chat-1#thread:thread-1')).toBe(newKey);
      expect(queueDepth(engine, 'feishu:chat-1:session-1')).toBe(0);
      expect(queueDepth(engine, newKey!)).toBe(1);
      expect(engine.getSessionsForChat('feishu', 'chat-1')).toHaveLength(0);
      expect(engine.getSessionsForChat('feishu', 'chat-1#thread:thread-1')[0].sessionKey).toBe(newKey);
    });
  });

  describe('file delivery routes', () => {
    it('resolves file delivery tokens without consuming them', () => {
      const token = engine.registerFileDeliveryRoute(
        DEFAULT_SESSION_KEY,
        {
          channelType: 'feishu',
          chatId: 'chat-1',
          scopeId: 'chat-1',
        },
        '/workdir',
      );

      expect(engine.resolveFileDeliveryToken(token)).toMatchObject({
        chatId: 'chat-1',
        cwd: '/workdir',
        sessionKey: DEFAULT_SESSION_KEY,
      });
      expect(engine.resolveFileDeliveryToken(token)).toMatchObject({
        chatId: 'chat-1',
        cwd: '/workdir',
        sessionKey: DEFAULT_SESSION_KEY,
      });
    });
  });
});
