import { describe, expect, it } from 'vitest';
import { stepUsageSuffix } from '../../server/channels/feishu/step-usage.js';

const old = { step: 1, inputTokens: 100, outputTokens: 20, contextTokens: 460, contextWindow: 1000 };
const latest = { step: 2, inputTokens: 10, outputTokens: 5, contextTokens: 28, contextWindow: 1000 };

describe('tool group usage suffix', () => {
  it('uses the latest context after compaction, regardless of tool/name order', () => {
    for (const usages of [[old, old, latest], [latest, old, old]]) {
      expect(stepUsageSuffix(usages.map(usage => ({ usage })))).toBe(' ↓110 ↑25 28 3%');
    }
  });

  it('does not reuse an earlier context window when the latest step has none', () => {
    const { contextWindow: _, ...unknownWindow } = latest;
    expect(stepUsageSuffix([{ usage: old }, { usage: unknownWindow }])).toBe(' ↓110 ↑25 28');
  });

  it('keeps missing usage absent', () => {
    expect(stepUsageSuffix([{}])).toBe('');
  });
});
