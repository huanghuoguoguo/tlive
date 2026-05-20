import { describe, expect, it } from 'vitest';
import { FEISHU_CHANNEL } from '../../channels/types.js';
import { FeishuAdapter } from '../../channels/index.js';

describe('Feishu channel exports', () => {
  it('uses Feishu as the only channel type', () => {
    expect(FEISHU_CHANNEL).toBe('feishu');
  });

  it('exports the Feishu adapter directly', () => {
    const adapter = new FeishuAdapter({
      appId: 'cli_test123',
      appSecret: 'secret',
      verificationToken: '',
      encryptKey: '',
      webhookPort: 0,
      allowedUsers: [],
    });

    expect(adapter.channelType).toBe('feishu');
  });
});
