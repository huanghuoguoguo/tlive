import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { WebhookServer, injectPayload } from '../../engine/automation/webhook.js';
import type { BridgeManager } from '../../engine/coordinators/bridge-manager.js';
import type { ProjectConfig } from '../../config.js';

// Mock fetch for callback tests
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('injectPayload', () => {
  it('should return unchanged prompt if no payload', () => {
    const prompt = 'Review the changes';
    expect(injectPayload(prompt)).toBe(prompt);
    expect(injectPayload(prompt, undefined)).toBe(prompt);
    expect(injectPayload(prompt, {})).toBe(prompt);
  });

  it('should inject simple string values', () => {
    const prompt = 'Review commit {commit} on branch {branch}';
    const payload = { commit: 'abc123', branch: 'main' };
    expect(injectPayload(prompt, payload)).toBe('Review commit abc123 on branch main');
  });

  it('should inject numeric values', () => {
    const prompt = 'Build #{number} failed after {seconds} seconds';
    const payload = { number: 42, seconds: 120 };
    expect(injectPayload(prompt, payload)).toBe('Build #42 failed after 120 seconds');
  });

  it('should keep placeholder if key not found in payload', () => {
    const prompt = 'Review {commit} by {author}';
    const payload = { commit: 'abc123' }; // author not provided
    expect(injectPayload(prompt, payload)).toBe('Review abc123 by {author}');
  });

  it('should keep placeholder if value is null or undefined', () => {
    const prompt = 'Review {commit} by {author}';
    const payload = { commit: 'abc123', author: null };
    expect(injectPayload(prompt, payload)).toBe('Review abc123 by {author}');

    const payload2 = { commit: 'abc123', author: undefined };
    expect(injectPayload(prompt, payload2)).toBe('Review abc123 by {author}');
  });

  it('should stringify object values', () => {
    const prompt = 'Check config: {config}';
    const payload = { config: { foo: 'bar', num: 1 } };
    expect(injectPayload(prompt, payload)).toBe('Check config: {"foo":"bar","num":1}');
  });

  it('should handle array values', () => {
    const prompt = 'Files changed: {files}';
    const payload = { files: ['a.ts', 'b.ts'] };
    expect(injectPayload(prompt, payload)).toBe('Files changed: ["a.ts","b.ts"]');
  });

  it('should handle boolean values', () => {
    const prompt = 'Success: {success}, Failed: {failed}';
    const payload = { success: true, failed: false };
    expect(injectPayload(prompt, payload)).toBe('Success: true, Failed: false');
  });

  it('should inject multiple occurrences of same key', () => {
    const prompt = 'Check {branch} and compare with {branch}';
    const payload = { branch: 'main' };
    expect(injectPayload(prompt, payload)).toBe('Check main and compare with main');
  });

  it('should only match word characters in placeholders', () => {
    const prompt = 'Path: {path}, Special: {not-a-key}';
    const payload = { path: '/src/main.ts' };
    // {not-a-key} contains hyphen, so it shouldn't be matched by \w+ pattern
    expect(injectPayload(prompt, payload)).toBe('Path: /src/main.ts, Special: {not-a-key}');
  });
});

describe('WebhookServer', () => {
  let server: WebhookServer;
  let mockBridge: Partial<BridgeManager>;
  let mockAdapter: any;

  beforeEach(() => {
    mockAdapter = {
      channelType: 'feishu',
      send: vi.fn().mockResolvedValue(undefined),
    };
    mockBridge = {
      getAdapter: vi.fn().mockReturnValue(mockAdapter),
      getAdapters: vi.fn().mockReturnValue([mockAdapter]),
      getLastChatId: vi.fn().mockReturnValue('chat-123'),
      hasActiveSession: vi.fn().mockReturnValue(false),
      getBinding: vi.fn().mockResolvedValue(null),
      getBindingBySessionId: vi.fn().mockResolvedValue(null),
      injectAutomationPrompt: vi.fn().mockResolvedValue({ sessionId: 'sdk-123' }),
      handleInboundMessage: vi.fn().mockResolvedValue(true),
    };
    mockFetch.mockClear();
  });

  afterEach(() => {
    if (server) {
      server.stop();
    }
  });

  describe('token validation', () => {
    function createResponse() {
      return {
        writeHead: vi.fn(),
        end: vi.fn(),
      };
    }

    it('rejects request without authorization header', async () => {
      server = new WebhookServer({
        token: 'test-token',
        port: 9999,
        path: '/webhook',
        bridge: mockBridge as BridgeManager,
        sessionStrategy: 'reject',
      });
      const res = createResponse();

      await (server as any).handleRequest({
        url: '/webhook',
        method: 'POST',
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
      }, res);

      expect(res.writeHead).toHaveBeenCalledWith(401, { 'Content-Type': 'application/json' });
      expect(JSON.parse(vi.mocked(res.end).mock.calls[0][0] as string)).toMatchObject({
        success: false,
        error: 'Missing or invalid Authorization header',
      });
    });

    it('rejects request with wrong token', async () => {
      server = new WebhookServer({
        token: 'test-token',
        port: 9999,
        path: '/webhook',
        bridge: mockBridge as BridgeManager,
        sessionStrategy: 'reject',
      });
      const res = createResponse();

      await (server as any).handleRequest({
        url: '/webhook',
        method: 'POST',
        headers: { authorization: 'Bearer wrong-token' },
        socket: { remoteAddress: '127.0.0.1' },
      }, res);

      expect(res.writeHead).toHaveBeenCalledWith(403, { 'Content-Type': 'application/json' });
      expect(JSON.parse(vi.mocked(res.end).mock.calls[0][0] as string)).toMatchObject({
        success: false,
        error: 'Invalid token',
      });
    });

    it('accepts request with correct token', async () => {
      server = new WebhookServer({
        token: 'test-token',
        port: 9999,
        path: '/webhook',
        bridge: mockBridge as BridgeManager,
        sessionStrategy: 'reject',
      });
      const res = createResponse();

      await (server as any).handleRequest({
        url: '/missing',
        method: 'GET',
        headers: { authorization: 'Bearer test-token' },
        socket: { remoteAddress: '127.0.0.1' },
      }, res);

      expect(res.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'application/json' });
      expect(JSON.parse(vi.mocked(res.end).mock.calls[0][0] as string)).toMatchObject({
        success: false,
        error: 'Not found',
      });
    });
  });

  describe('request validation', () => {
    beforeEach(() => {
      server = new WebhookServer({
        token: 'test-token',
        port: 9999,
        path: '/webhook',
        bridge: mockBridge as BridgeManager,
        sessionStrategy: 'reject',
      });
    });

    it('requires prompt field', () => {
      expect((server as any).validateRequest({ event: 'test' })).toBe(
        'Missing required field: prompt',
      );
    });

    it('rejects prompt longer than 10000 characters', () => {
      expect((server as any).validateRequest({
        event: 'test',
        prompt: 'x'.repeat(10001),
      })).toBe('Prompt too long (max 10000 characters)');
    });

    it('validates payload size limit', () => {
      expect((server as any).validateRequest({
        event: 'test',
        prompt: 'Hello',
        payload: { data: 'x'.repeat(4097) },
      })).toBe('Payload too large (max 4096 characters)');
    });

    it('validates payload field count limit', () => {
      expect((server as any).validateRequest({
        event: 'test',
        prompt: 'Hello',
        payload: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i])),
      })).toBe('Payload has too many fields (max 20)');
    });
  });

  describe('rate limiting', () => {
    it('allows requests while under the per-minute limit', () => {
      server = new WebhookServer({
        token: 'test-token',
        port: 9999,
        path: '/webhook',
        bridge: mockBridge as BridgeManager,
        sessionStrategy: 'reject',
        rateLimitPerMinute: 2,
      });

      expect((server as any).allowRequestForSource('127.0.0.1', 1_000)).toBe(true);
      expect((server as any).allowRequestForSource('127.0.0.1', 2_000)).toBe(true);
    });

    it('rejects requests that exceed the per-minute limit', () => {
      server = new WebhookServer({
        token: 'test-token',
        port: 9999,
        path: '/webhook',
        bridge: mockBridge as BridgeManager,
        sessionStrategy: 'reject',
        rateLimitPerMinute: 2,
      });

      expect((server as any).allowRequestForSource('127.0.0.1', 1_000)).toBe(true);
      expect((server as any).allowRequestForSource('127.0.0.1', 2_000)).toBe(true);
      expect((server as any).allowRequestForSource('127.0.0.1', 3_000)).toBe(false);
    });

    it('expires old requests from the rate-limit window', () => {
      server = new WebhookServer({
        token: 'test-token',
        port: 9999,
        path: '/webhook',
        bridge: mockBridge as BridgeManager,
        sessionStrategy: 'reject',
        rateLimitPerMinute: 1,
      });

      expect((server as any).allowRequestForSource('127.0.0.1', 1_000)).toBe(true);
      expect((server as any).allowRequestForSource('127.0.0.1', 30_000)).toBe(false);
      expect((server as any).allowRequestForSource('127.0.0.1', 62_000)).toBe(true);
    });

    it('cleans up idle rate-limit buckets', () => {
      server = new WebhookServer({
        token: 'test-token',
        port: 9999,
        path: '/webhook',
        bridge: mockBridge as BridgeManager,
        sessionStrategy: 'reject',
        rateLimitPerMinute: 1,
      });

      expect((server as any).allowRequestForSource('127.0.0.1', 1_000)).toBe(true);
      expect((server as any).recentRequestsBySource.has('127.0.0.1')).toBe(true);
      expect((server as any).allowRequestForSource('127.0.0.1', 62_000)).toBe(true);
      expect((server as any).recentRequestsBySource.get('127.0.0.1')).toHaveLength(1);
    });
  });

  describe('project routing', () => {
    it('resolves route with explicit channelType and chatId', async () => {
      server = new WebhookServer({
        token: 'test-token',
        port: 9999,
        path: '/webhook',
        bridge: mockBridge as BridgeManager,
        sessionStrategy: 'reject',
      });
      vi.mocked(mockBridge.getBinding!).mockResolvedValue({
        channelType: 'feishu',
        chatId: 'chat-explicit',
        sessionId: 'binding-1',
        cwd: '/repo/explicit',
        projectName: 'explicit-project',
        agentSettingSources: ['user', 'project'],
        createdAt: '',
      } as any);

      const route = await (server as any).resolveRoute({
        event: 'test',
        prompt: 'Hello',
        channelType: 'feishu',
        chatId: 'chat-explicit',
      });

      expect(route).toEqual({
        channelType: 'feishu',
        chatId: 'chat-explicit',
        workdir: '/repo/explicit',
        projectName: 'explicit-project',
        settingSources: ['user', 'project'],
      });
    });

    it('resolves route with projectName using webhookDefaultChat', async () => {
      const projects: ProjectConfig[] = [
        {
          name: 'project-a',
          workdir: '/repo/a',
          agentSettingSources: ['user'],
          webhookDefaultChat: { channelType: 'feishu', chatId: 'chat-a' },
        },
      ];
      server = new WebhookServer({
        token: 'test-token',
        port: 9999,
        path: '/webhook',
        bridge: mockBridge as BridgeManager,
        sessionStrategy: 'reject',
        projects,
      });

      const route = await (server as any).resolveRoute({
        event: 'test',
        prompt: 'Hello',
        projectName: 'project-a',
      });

      expect(route).toEqual({
        channelType: 'feishu',
        chatId: 'chat-a',
        workdir: '/repo/a',
        projectName: 'project-a',
        settingSources: ['user'],
      });
    });

    it('resolves route with projectName using last active chat', async () => {
      const projects: ProjectConfig[] = [
        {
          name: 'project-b',
          workdir: '/repo/b',
          agentSettingSources: ['user', 'local'],
        },
      ];
      server = new WebhookServer({
        token: 'test-token',
        port: 9999,
        path: '/webhook',
        bridge: mockBridge as BridgeManager,
        sessionStrategy: 'reject',
        projects,
      });

      const route = await (server as any).resolveRoute({
        event: 'test',
        prompt: 'Hello',
        projectName: 'project-b',
      });

      expect(route).toEqual({
        channelType: 'feishu',
        chatId: 'chat-123',
        workdir: '/repo/b',
        projectName: 'project-b',
        settingSources: ['user', 'local'],
      });
      expect(mockBridge.getLastChatId).toHaveBeenCalledWith('feishu');
    });

    it('returns null for invalid projectName', async () => {
      server = new WebhookServer({
        token: 'test-token',
        port: 9999,
        path: '/webhook',
        bridge: mockBridge as BridgeManager,
        sessionStrategy: 'reject',
        projects: [{ name: 'project-a', workdir: '/repo/a' }],
      });

      const route = await (server as any).resolveRoute({
        event: 'test',
        prompt: 'Hello',
        projectName: 'missing',
      });

      expect(route).toBeNull();
    });

    it('uses defaultProject when no target specified', async () => {
      const projects: ProjectConfig[] = [
        {
          name: 'default',
          workdir: '/repo/default',
          webhookDefaultChat: { channelType: 'feishu', chatId: 'chat-default' },
        },
      ];
      server = new WebhookServer({
        token: 'test-token',
        port: 9999,
        path: '/webhook',
        bridge: mockBridge as BridgeManager,
        sessionStrategy: 'reject',
        projects,
        defaultProject: 'default',
      });

      const route = await (server as any).resolveRoute({
        event: 'test',
        prompt: 'Hello',
      });

      expect(route).toEqual({
        channelType: 'feishu',
        chatId: 'chat-default',
        workdir: '/repo/default',
        projectName: 'default',
        settingSources: undefined,
      });
    });

    it('resolves route from sessionId before chat coordinates', async () => {
      server = new WebhookServer({
        token: 'test-token',
        port: 9999,
        path: '/webhook',
        bridge: mockBridge as BridgeManager,
        sessionStrategy: 'reject',
      });

      vi.mocked(mockBridge.getBindingBySessionId!).mockResolvedValue({
        channelType: 'feishu',
        chatId: 'chat-from-session',
        sessionId: 'binding-1',
        sdkSessionId: 'sdk-456',
        cwd: '/repo/session',
        createdAt: '',
      } as any);

      const route = await (server as any).resolveRoute({
        event: 'test',
        prompt: 'Hello',
        channelType: 'feishu',
        chatId: 'chat-ignored',
        sessionId: 'sdk-456',
      });

      expect(route).toEqual({
        channelType: 'feishu',
        chatId: 'chat-from-session',
        workdir: '/repo/session',
        projectName: undefined,
        settingSources: undefined,
      });
      expect(mockBridge.getBindingBySessionId).toHaveBeenCalledWith('sdk-456');
      expect(mockBridge.getBinding).not.toHaveBeenCalled();
    });
  });

  describe('session routing strategy', () => {
    it('reject strategy should fail when no active session exists', async () => {
      server = new WebhookServer({
        token: 'test-token',
        port: 9999,
        path: '/webhook',
        bridge: mockBridge as BridgeManager,
        sessionStrategy: 'reject',
      });

      vi.mocked(mockBridge.getBinding!).mockResolvedValue({
        channelType: 'feishu',
        chatId: 'chat-123',
        sessionId: 'binding-1',
        cwd: '/repo/session',
        createdAt: '',
      } as any);

      const result = await (server as any).deliverPrompt(
        {
          event: 'test',
          prompt: 'Hello',
          channelType: 'feishu',
          chatId: 'chat-123',
        },
        {
          channelType: 'feishu',
          chatId: 'chat-123',
          workdir: '/repo/session',
        },
        'Hello',
        'req-1',
      );

      expect(result).toEqual({
        success: false,
        error: 'No active session for feishu:chat-123. Start a conversation in IM first, or set webhook.sessionStrategy=\'create\'.',
      });
      expect(mockBridge.hasActiveSession).toHaveBeenCalledWith('feishu', 'chat-123', '/repo/session');
      expect(mockBridge.injectAutomationPrompt).not.toHaveBeenCalled();
    });

    it('create strategy should allow without active session', async () => {
      server = new WebhookServer({
        token: 'test-token',
        port: 9999,
        path: '/webhook',
        bridge: mockBridge as BridgeManager,
        sessionStrategy: 'create',
      });

      const result = await (server as any).deliverPrompt(
        {
          event: 'test',
          prompt: 'Hello',
          channelType: 'feishu',
          chatId: 'chat-123',
        },
        {
          channelType: 'feishu',
          chatId: 'chat-123',
          workdir: '/repo/session',
        },
        'Hello',
        'req-2',
      );

      expect(result).toEqual({
        success: true,
        sessionId: 'sdk-123',
      });
      expect(mockBridge.hasActiveSession).not.toHaveBeenCalled();
      expect(mockBridge.injectAutomationPrompt).toHaveBeenCalledWith(expect.objectContaining({
        channelType: 'feishu',
        chatId: 'chat-123',
        text: 'Hello',
        workdir: '/repo/session',
      }));
    });
  });

});
