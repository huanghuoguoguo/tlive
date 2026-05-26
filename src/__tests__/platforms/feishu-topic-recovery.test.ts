import { describe, expect, it } from 'vitest';
import { buildFeishuCard } from '../../server/channels/feishu/card-builder.js';
import { extractFeishuMessageTopicMetadata } from '../../server/channels/feishu/topic-recovery.js';
import { withTliveTopicMetadata } from '../../shared/topic-metadata.js';

describe('Feishu topic recovery metadata', () => {
  it('extracts TLive metadata from an interactive card body', () => {
    const content = buildFeishuCard({
      elements: [
        {
          tag: 'markdown',
          content: withTliveTopicMetadata('继续在本话题内发送消息。', {
            provider: 'codex',
            clientId: 'client-1',
            cwd: '/repo',
            sdkSessionId: 'sdk-1',
          }),
        },
      ],
    });

    expect(extractFeishuMessageTopicMetadata(content)).toMatchObject({
      provider: 'codex',
      clientId: 'client-1',
      cwd: '/repo',
      sdkSessionId: 'sdk-1',
    });
  });
});
