import { describe, expect, it } from 'vitest';
import { toCodexReasoningEffort } from '../../providers/codex-sdk.js';

describe('CodexSDKProvider', () => {
  it('maps canonical max effort to Codex xhigh', () => {
    expect(toCodexReasoningEffort('max')).toBe('xhigh');
    expect(toCodexReasoningEffort('high')).toBe('high');
    expect(toCodexReasoningEffort(undefined)).toBeUndefined();
  });
});
