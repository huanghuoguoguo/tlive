import { describe, expect, it } from 'vitest';
import { chatScopeId } from '../../shared/core/key.js';
import {
  buildActiveSdkSessionBindings,
  buildHomeSessionEntries,
  buildRecentProjects,
  buildTopicEntries,
  hasActiveTaskInConversation,
} from '../../server/presentation/home-model.js';
import { TopicSessionManager } from '../../server/engine/state/topic-sessions.js';
import type { ScannedSession } from '../../client/providers/session-scanner.js';
import type { ChannelBinding } from '../../server/store/interface.js';

const stateKey = (channelType: string, chatId: string) => `${channelType}:${chatId}`;

function scanned(overrides: Partial<ScannedSession>): ScannedSession {
  return {
    sdkSessionId: 'sdk-1',
    projectDir: '-repo',
    filePath: '/does/not/exist.jsonl',
    cwd: '/repo',
    mtime: Date.UTC(2026, 0, 1),
    size: 1024,
    preview: 'preview',
    ...overrides,
    provider: overrides.provider ?? 'claude',
    providerDisplayName: overrides.providerDisplayName ?? 'Claude',
  };
}

describe('home model helpers', () => {
  it('detects active work for a workbench when a topic in the chat is running', () => {
    const activeControls = new Map<string, any>([
      [stateKey('feishu', chatScopeId('chat-1', 'thread-1')), {}],
    ]);

    expect(hasActiveTaskInConversation('feishu', 'chat-1', activeControls, stateKey)).toBe(true);
    expect(hasActiveTaskInConversation('feishu', 'chat-2', activeControls, stateKey)).toBe(false);
  });

  it('deduplicates recent projects by cwd and sorts by latest activity', () => {
    const projects = buildRecentProjects([
      scanned({ cwd: '/repo/a', mtime: 10 }),
      scanned({ cwd: '/repo/b', mtime: 30 }),
      scanned({ cwd: '/repo/a', mtime: 40 }),
    ], '/repo/b');

    expect(projects.map(p => p.fullWorkdir)).toEqual(['/repo/a', '/repo/b']);
    expect(projects[1]).toMatchObject({ name: 'b', isCurrent: true });
  });

  it('maps scanned sessions with topic and active binding metadata', () => {
    const topicSessions = new TopicSessionManager();
    const scopeId = chatScopeId('chat-1', 'thread-1');
    topicSessions.upsert({
      channelType: 'feishu',
      chatId: 'chat-1',
      scopeId,
      threadId: 'thread-1',
      sdkSessionId: 'sdk-1',
      cwd: '/repo',
      title: 'Topic',
      preview: 'Topic preview',
    });

    const bindings: ChannelBinding[] = [{
      channelType: 'feishu',
      chatId: scopeId,
      sessionId: 'binding-1',
      sdkSessionId: 'sdk-1',
      cwd: '/repo',
      createdAt: '',
    }];
    const activeControls = new Map<string, any>([[stateKey('feishu', scopeId), {}]]);
    const activeBindings = buildActiveSdkSessionBindings(bindings, activeControls, stateKey);

    const entries = buildHomeSessionEntries([scanned({ sdkSessionId: 'sdk-1' })], {
      binding: { ...bindings[0], chatId: 'chat-1' },
      activeSdkSessionBindings: activeBindings,
      channelType: 'feishu',
      chatId: 'chat-1',
      topicSessions,
      now: Date.UTC(2026, 0, 2),
      locale: 'zh',
      boundFilter: bi => bi?.isActive ? bi : undefined,
    });

    expect(entries[0]).toMatchObject({
      sdkSessionId: 'sdk-1',
      topic: { scopeId, threadId: 'thread-1', isActive: true },
      boundToActiveSession: { channelType: 'feishu', chatId: scopeId, isActive: true },
      isCurrent: true,
    });
  });

  it('builds workbench topic entries only when a client reports the sdk session', () => {
    const topicSessions = new TopicSessionManager();
    const scopeId = chatScopeId('chat-1', 'thread-1');
    topicSessions.upsert({
      channelType: 'feishu',
      chatId: 'chat-1',
      scopeId,
      threadId: 'thread-1',
      sdkSessionId: 'sdk-1',
      cwd: '/repo/topic',
      title: 'Topic title',
      preview: 'Topic preview',
    });

    const entries = buildTopicEntries({
      topicSessions,
      channelType: 'feishu',
      chatId: 'chat-1',
      currentCwd: '/repo',
      binding: { channelType: 'feishu', chatId: 'chat-1', sessionId: 's', sdkSessionId: 'sdk-1', createdAt: '' },
      activeControls: new Map([[stateKey('feishu', scopeId), {} as any]]),
      stateKey,
      locale: 'zh',
      resolveClientSession: () => ({
        provider: 'claude',
        providerDisplayName: 'Claude',
        clientId: 'worker-1',
        sdkSessionId: 'sdk-1',
        cwd: '/repo/topic',
        mtime: Date.UTC(2026, 0, 1),
        preview: 'Client preview',
      }),
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      scopeId,
      threadId: 'thread-1',
      cwd: '/repo/topic',
      title: 'Topic title',
      preview: 'Client preview',
      clientId: 'worker-1',
      isCurrent: true,
      isActive: true,
    });
  });

  it('does not expose stale topic records that no client currently reports', () => {
    const topicSessions = new TopicSessionManager();
    const scopeId = chatScopeId('chat-1', 'thread-1');
    topicSessions.upsert({
      channelType: 'feishu',
      chatId: 'chat-1',
      scopeId,
      threadId: 'thread-1',
      sdkSessionId: 'sdk-1',
      cwd: '/tmp/tlive-remote-smoke',
      title: 'Remote topic',
      preview: 'Remote topic',
    });

    const entries = buildTopicEntries({
      topicSessions,
      channelType: 'feishu',
      chatId: 'chat-1',
      currentCwd: '/repo',
      activeControls: new Map(),
      stateKey,
      locale: 'zh',
    });

    expect(entries).toEqual([]);
  });
});
