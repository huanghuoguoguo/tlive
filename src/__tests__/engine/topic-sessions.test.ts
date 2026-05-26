import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TopicSessionManager } from '../../server/engine/state/topic-sessions.js';

describe('TopicSessionManager', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function createManager(): TopicSessionManager {
    tmpDir = mkdtempSync(join(tmpdir(), 'tlive-topic-sessions-'));
    return new TopicSessionManager(tmpDir);
  }

  it('persists and restores topic sessions', () => {
    const manager = createManager();
    manager.upsert({
      channelType: 'feishu',
      chatId: 'chat-1',
      scopeId: 'chat-1#thread:thread-1',
      threadId: 'thread-1',
      rootMessageId: 'msg-root',
      entryMessageId: 'msg-entry',
      lastMessageId: 'msg-last',
      sdkSessionId: 'sdk-1',
      cwd: '/repo',
      title: 'Build feature',
      preview: 'Build feature',
    });

    const restored = new TopicSessionManager(tmpDir);
    expect(restored.findBySdkSessionId('sdk-1')).toMatchObject({
      scopeId: 'chat-1#thread:thread-1',
      entryMessageId: 'msg-entry',
      lastMessageId: 'msg-last',
      cwd: '/repo',
    });
  });

  it('keeps one topic per provider session id', () => {
    const manager = createManager();
    manager.upsert({
      channelType: 'feishu',
      chatId: 'chat-1',
      scopeId: 'chat-1#thread:old',
      threadId: 'old',
      sdkSessionId: 'sdk-1',
    });
    manager.upsert({
      channelType: 'feishu',
      chatId: 'chat-1',
      scopeId: 'chat-1#thread:new',
      threadId: 'new',
      sdkSessionId: 'sdk-1',
    });

    expect(manager.findByScope('chat-1#thread:old')).toBeUndefined();
    expect(manager.findBySdkSessionId('sdk-1')?.scopeId).toBe('chat-1#thread:new');
    expect(manager.listRecent(10, { channelType: 'feishu', chatId: 'chat-1' })).toHaveLength(1);
  });

  it('keeps separate topics when different providers reuse the same session id', () => {
    const manager = createManager();
    manager.upsert({
      channelType: 'feishu',
      chatId: 'chat-1',
      scopeId: 'chat-1#thread:claude',
      threadId: 'claude',
      sdkSessionId: 'same-id',
      provider: 'claude',
    });
    manager.upsert({
      channelType: 'feishu',
      chatId: 'chat-1',
      scopeId: 'chat-1#thread:codex',
      threadId: 'codex',
      sdkSessionId: 'same-id',
      provider: 'codex',
    });

    expect(manager.findBySdkSession('claude', 'same-id')?.scopeId).toBe('chat-1#thread:claude');
    expect(manager.findBySdkSession('codex', 'same-id')?.scopeId).toBe('chat-1#thread:codex');
    expect(manager.listRecent(10, { channelType: 'feishu', chatId: 'chat-1' })).toHaveLength(2);
  });

  it('updates the last message anchor', () => {
    const manager = createManager();
    manager.upsert({
      channelType: 'feishu',
      chatId: 'chat-1',
      scopeId: 'chat-1#thread:thread-1',
      threadId: 'thread-1',
      lastMessageId: 'msg-1',
      sdkSessionId: 'sdk-1',
    });

    manager.updateLastMessage('chat-1#thread:thread-1', 'msg-2');

    expect(manager.findBySdkSessionId('sdk-1')?.lastMessageId).toBe('msg-2');
  });
});
