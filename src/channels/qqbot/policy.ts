import type { ProgressPhase, ProgressTraceStats, PermissionDecision } from '../../ui/policy.js';
import type { ChannelPolicy, ProgressPolicy, ReactionPolicy } from '../../ui/channel-policy.js';

// --- QQBot Progress Policy ---
// QQBot suppresses progress updates during execution phase.

const QQBOT_PROGRESS: ProgressPolicy = {
  shouldRenderPhase: (phase: ProgressPhase): boolean => {
    // Suppress progress updates during starting and execution phases.
    // Only render waiting_permission, completed, failed.
    return phase !== 'starting' && phase !== 'executing';
  },

  shouldSplitCompletedTrace: (_stats: ProgressTraceStats) => false,
};

// --- QQBot Reaction Policy ---

const QQBOT_REACTIONS: ReactionPolicy = {
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

/** QQBot platform policy. */
export const QQBOT_POLICY: ChannelPolicy = {
  locale: 'zh',
  progress: QQBOT_PROGRESS,
  reactions: QQBOT_REACTIONS,
};