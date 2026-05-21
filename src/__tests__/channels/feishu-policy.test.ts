import { describe, expect, it } from 'vitest';
import { FEISHU_POLICY } from '../../channels/feishu/policy.js';
import type { ChannelPolicy } from '../../channels/policy.js';

describe('Feishu channel policy', () => {
  it('uses the Feishu locale and platform reaction names', () => {
    expect(FEISHU_POLICY.locale).toBe('zh');
    expect(FEISHU_POLICY.reactions.processing).toBe('Typing');
    expect(FEISHU_POLICY.reactions.done).toBe('OK');
    expect(FEISHU_POLICY.reactions.error).toBe('FACEPALM');
    expect(FEISHU_POLICY.reactions.stalled).toBe('OneSecond');
    expect(FEISHU_POLICY.reactions.permission).toBe('Pin');
  });

  it('maps text permission decisions to Feishu reactions', () => {
    expect(FEISHU_POLICY.reactions.getPermissionDecision('deny')).toBe('No');
    expect(FEISHU_POLICY.reactions.getPermissionDecision('allow_always')).toBe('DONE');
    expect(FEISHU_POLICY.reactions.getPermissionDecision('allow')).toBe('OK');
  });

  it('keeps short completed traces in one card and splits large traces', () => {
    expect(FEISHU_POLICY.progress.shouldSplitCompletedTrace({
      thinkingTextLength: 0,
      timelineLength: 0,
      thinkingEntries: 0,
      toolEntries: 0,
      responseTextLength: 100,
    })).toBe(false);
    expect(FEISHU_POLICY.progress.shouldSplitCompletedTrace({
      thinkingTextLength: 5000,
      timelineLength: 12,
      thinkingEntries: 4,
      toolEntries: 8,
      responseTextLength: 2000,
    })).toBe(true);
  });

  it('formats code output as a fenced block', () => {
    expect(FEISHU_POLICY.format.formatCodeOutput('console.log("hello")'))
      .toBe('```\nconsole.log("hello")\n```\n');
  });

  it('exposes a narrow channel policy type without a default platform instance', () => {
    const policy: ChannelPolicy = FEISHU_POLICY;
    expect(policy.progress.shouldRenderPhase('executing')).toBe(true);
  });
});
