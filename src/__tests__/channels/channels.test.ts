import { describe, it, expect, beforeEach } from 'vitest';
import { createAdapter, getRegisteredTypes } from '../../channels/index.js';

// Import adapters to trigger self-registration
import '../../platforms/telegram/adapter.js';
import '../../platforms/feishu/adapter.js';
import '../../platforms/qqbot/adapter.js';

describe('Channel Adapter Registry', () => {
  beforeEach(() => {
    process.env.TL_TOKEN = 'test-token';
  });
  it('has all three adapters registered', () => {
    const types = getRegisteredTypes();
    expect(types).toContain('telegram');
    expect(types).toContain('feishu');
    expect(types).toContain('qqbot');
  });

  it('creates telegram adapter', () => {
    const adapter = createAdapter('telegram');
    expect(adapter.channelType).toBe('telegram');
  });

  it('throws on unknown channel type', () => {
    expect(() => createAdapter('unknown' as any)).toThrow('Unknown channel type: unknown');
  });
});