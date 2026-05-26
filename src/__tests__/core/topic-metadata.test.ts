import { describe, expect, it } from 'vitest';
import {
  extractTliveTopicMetadata,
  findTliveTopicMetadata,
  stripTliveTopicMetadata,
  withTliveTopicMetadata,
} from '../../shared/topic-metadata.js';

describe('TLive topic metadata', () => {
  it('round-trips metadata through a markdown-safe marker', () => {
    const text = withTliveTopicMetadata('继续在本话题内发送消息。', {
      provider: 'codex',
      clientId: 'remote-1',
      cwd: '/repo/tlive',
      sdkSessionId: 'sdk-1',
      threadId: 'thread-1',
      rootMessageId: 'msg-root',
      entryMessageId: 'msg-entry',
      title: 'TLive · Codex · tlive',
    });

    expect(text).toContain('tlive-topic:');
    expect(stripTliveTopicMetadata(text)).toBe('继续在本话题内发送消息。');
    expect(extractTliveTopicMetadata(text)).toMatchObject({
      type: 'tlive.topic',
      version: 1,
      provider: 'codex',
      clientId: 'remote-1',
      cwd: '/repo/tlive',
      sdkSessionId: 'sdk-1',
      threadId: 'thread-1',
      rootMessageId: 'msg-root',
      entryMessageId: 'msg-entry',
      title: 'TLive · Codex · tlive',
    });
  });

  it('finds metadata inside nested Feishu card content', () => {
    const card = {
      body: {
        elements: [
          { tag: 'markdown', content: '普通内容' },
          {
            tag: 'markdown',
            content: withTliveTopicMetadata('entry', {
              provider: 'claude',
              sdkSessionId: 'sdk-2',
            }),
          },
        ],
      },
    };

    expect(findTliveTopicMetadata(card)).toMatchObject({
      provider: 'claude',
      sdkSessionId: 'sdk-2',
    });
  });
});
