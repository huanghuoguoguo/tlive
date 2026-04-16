import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CHANNEL_POLICY,
  type ChannelPolicy,
  type ProgressPolicy,
  type ReactionPolicy,
  type FormatPolicy,
} from '../../ui/channel-policy.js';

describe('ui/channel-policy', () => {
  describe('DEFAULT_CHANNEL_POLICY', () => {
    it('has en locale by default', () => {
      expect(DEFAULT_CHANNEL_POLICY.locale).toBe('en');
    });

    it('has progress policy', () => {
      expect(DEFAULT_CHANNEL_POLICY.progress).toBeDefined();
      expect(DEFAULT_CHANNEL_POLICY.progress.shouldRenderPhase).toBeTypeOf('function');
      expect(DEFAULT_CHANNEL_POLICY.progress.shouldSplitCompletedTrace).toBeTypeOf('function');
    });

    it('has reactions policy', () => {
      expect(DEFAULT_CHANNEL_POLICY.reactions).toBeDefined();
      expect(DEFAULT_CHANNEL_POLICY.reactions.processing).toBe('⏳');
      expect(DEFAULT_CHANNEL_POLICY.reactions.done).toBe('✅');
      expect(DEFAULT_CHANNEL_POLICY.reactions.error).toBe('❌');
      expect(DEFAULT_CHANNEL_POLICY.reactions.stalled).toBe('⏸');
      expect(DEFAULT_CHANNEL_POLICY.reactions.permission).toBe('🔐');
    });

    it('has format policy', () => {
      expect(DEFAULT_CHANNEL_POLICY.format).toBeDefined();
      expect(DEFAULT_CHANNEL_POLICY.format.formatCodeOutput).toBeTypeOf('function');
    });
  });

  describe('ProgressPolicy', () => {
    it('shouldRenderPhase returns true for all phases by default', () => {
      const policy = DEFAULT_CHANNEL_POLICY.progress;
      expect(policy.shouldRenderPhase('starting')).toBe(true);
      expect(policy.shouldRenderPhase('executing')).toBe(true);
      expect(policy.shouldRenderPhase('waiting_permission')).toBe(true);
      expect(policy.shouldRenderPhase('completed')).toBe(true);
      expect(policy.shouldRenderPhase('failed')).toBe(true);
    });

    it('shouldSplitCompletedTrace returns false by default', () => {
      const policy = DEFAULT_CHANNEL_POLICY.progress;
      expect(policy.shouldSplitCompletedTrace({ toolCount: 10, durationMs: 60000 })).toBe(false);
    });
  });

  describe('ReactionPolicy', () => {
    it('getPermissionDecision returns correct emoji for deny', () => {
      const policy = DEFAULT_CHANNEL_POLICY.reactions;
      expect(policy.getPermissionDecision('deny')).toBe('❌');
    });

    it('getPermissionDecision returns correct emoji for allow_always', () => {
      const policy = DEFAULT_CHANNEL_POLICY.reactions;
      expect(policy.getPermissionDecision('allow_always')).toBe('📌');
    });

    it('getPermissionDecision returns correct emoji for allow', () => {
      const policy = DEFAULT_CHANNEL_POLICY.reactions;
      expect(policy.getPermissionDecision('allow')).toBe('✅');
    });
  });

  describe('FormatPolicy', () => {
    it('formatCodeOutput wraps text in pre tags', () => {
      const policy = DEFAULT_CHANNEL_POLICY.format;
      const result = policy.formatCodeOutput('console.log("hello")');
      expect(result).toBe('<pre>console.log("hello")</pre>');
    });

    it('formatCodeOutput escapes HTML in text', () => {
      const policy = DEFAULT_CHANNEL_POLICY.format;
      const result = policy.formatCodeOutput('<script>alert(1)</script>');
      expect(result).toContain('&lt;');
      expect(result).toContain('&gt;');
    });
  });

  describe('ChannelPolicy type', () => {
    it('can create custom policy', () => {
      const customPolicy: ChannelPolicy = {
        locale: 'zh',
        progress: {
          shouldRenderPhase: (phase) => phase === 'executing',
          shouldSplitCompletedTrace: () => true,
        },
        reactions: {
          processing: '🔄',
          done: '🎉',
          error: '💥',
          stalled: '⏸',
          permission: '🔒',
          getPermissionDecision: () => '✅',
        },
        format: {
          formatCodeOutput: (text) => `\`\`\`\n${text}\n\`\`\``,
        },
      };

      expect(customPolicy.locale).toBe('zh');
      expect(customPolicy.progress.shouldRenderPhase('starting')).toBe(false);
      expect(customPolicy.progress.shouldRenderPhase('executing')).toBe(true);
    });
  });
});