import { describe, it, expect } from 'vitest';
import { ClaudeSDKProvider } from '../../providers/claude-sdk.js';

describe('ClaudeSDKProvider', () => {
  it('creates a StreamChatResult with stream from streamChat', () => {
    const provider = new ClaudeSDKProvider();
    const result = provider.streamChat({
      prompt: 'test',
      workingDirectory: '/tmp',
    });
    expect(result).toHaveProperty('stream');
    expect(result.stream).toBeInstanceOf(ReadableStream);
  });

  it('constructor accepts setting sources', () => {
    const provider = new ClaudeSDKProvider(['user']);
    expect(provider).toBeInstanceOf(ClaudeSDKProvider);
  });
});
