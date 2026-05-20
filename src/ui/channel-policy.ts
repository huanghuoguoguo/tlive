import type { ProgressPhase, ProgressTraceStats, PermissionDecision } from './policy.js';

/**
 * Platform behavior policy — controls how engine renders and responds.
 * Extracted from BaseChannelAdapter to give engine a cleaner dependency.
 */

export interface ProgressPolicy {
  /** Whether to render a progress update for the given phase. */
  shouldRenderPhase(phase: ProgressPhase): boolean;

  /** Whether to split a completed trace into trace + summary cards. */
  shouldSplitCompletedTrace(stats: ProgressTraceStats): boolean;
}

export interface ReactionPolicy {
  /** Emoji reactions for lifecycle/status updates. */
  processing: string;
  done: string;
  error: string;
  stalled: string;
  permission: string;

  /** Reaction for a text-based permission decision. */
  getPermissionDecision(decision: PermissionDecision): string;
}

export interface FormatPolicy {
  /** Format code output for this platform. */
  formatCodeOutput(text: string): string;
}

export interface ChannelPolicy {
  /** Language preference for messages. */
  locale: 'en' | 'zh';

  /** Progress rendering policy. */
  progress: ProgressPolicy;

  /** Reaction emoji policy. */
  reactions: ReactionPolicy;

  /** Code output formatting policy. */
  format: FormatPolicy;
}

// --- Default implementations ---

const DEFAULT_PROGRESS: ProgressPolicy = {
  shouldRenderPhase: (_phase: ProgressPhase) => true,
  shouldSplitCompletedTrace: (_stats: ProgressTraceStats) => false,
};

const DEFAULT_REACTIONS: ReactionPolicy = {
  processing: '⏳',
  done: '✅',
  error: '❌',
  stalled: '⏸',
  permission: '🔐',
  getPermissionDecision: (decision: PermissionDecision) => {
    switch (decision) {
      case 'deny': return '❌';
      case 'allow_always': return '📌';
      default: return '✅';
    }
  },
};

const DEFAULT_FORMAT: FormatPolicy = {
  formatCodeOutput: (text: string) => `\`\`\`\n${text}\n\`\`\`\n`,
};

/** Default channel policy used by tests and lightweight adapters. */
export const DEFAULT_CHANNEL_POLICY: ChannelPolicy = {
  locale: 'en',
  progress: DEFAULT_PROGRESS,
  reactions: DEFAULT_REACTIONS,
  format: DEFAULT_FORMAT,
};
