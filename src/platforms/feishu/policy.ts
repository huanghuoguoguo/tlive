import type { ProgressPhase, ProgressTraceStats, PermissionDecision } from '../../ui/policy.js';
import type { ChannelPolicy, ProgressPolicy, ReactionPolicy } from '../../ui/channel-policy.js';

// --- Feishu Progress Policy ---

const FEISHU_PROGRESS: ProgressPolicy = {
  shouldRenderPhase: (_phase: ProgressPhase) => true,

  shouldSplitCompletedTrace: (stats: ProgressTraceStats): boolean => {
    const hasLongTrace = stats.thinkingTextLength > 80 || stats.timelineLength >= 4;
    const hasMeaningfulTooling = stats.toolEntries >= 2 || (stats.toolEntries >= 1 && stats.thinkingEntries >= 1);
    const hasLongAnswer = stats.responseTextLength > 200;
    return hasMeaningfulTooling || hasLongTrace || (stats.toolEntries >= 1 && hasLongAnswer);
  },
};

// --- Feishu Reaction Policy ---
// Feishu reactions use platform-defined type names, not Unicode emoji

const FEISHU_REACTIONS: ReactionPolicy = {
  processing: 'Typing',
  done: 'OK',
  error: 'FACEPALM',
  stalled: 'OneSecond',
  permission: 'Pin',
  getPermissionDecision: (decision: PermissionDecision) => {
    switch (decision) {
      case 'deny': return 'No';
      case 'allow_always': return 'DONE';
      default: return 'OK';
    }
  },
};

/** Feishu platform policy. */
export const FEISHU_POLICY: ChannelPolicy = {
  locale: 'zh',
  progress: FEISHU_PROGRESS,
  reactions: FEISHU_REACTIONS,
};