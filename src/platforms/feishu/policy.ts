import type { ProgressPhase, ProgressTraceStats, PermissionDecision } from '../../ui/policy.js';
import type { ChannelPolicy, ProgressPolicy, ReactionPolicy } from '../../ui/channel-policy.js';

// --- Feishu Progress Policy ---

const FEISHU_PROGRESS: ProgressPolicy = {
  shouldRenderPhase: (_phase: ProgressPhase) => true,

  shouldSplitCompletedTrace: (stats: ProgressTraceStats): boolean => {
    const totalEntries = stats.thinkingEntries + stats.toolEntries;

    // 无轨迹 → 不分割（纯文本回复）
    if (totalEntries === 0) {
      return false;
    }

    // 三轮内（thinking + tool ≤ 3）→ 不分割，保持简洁
    if (totalEntries <= 3) {
      return false;
    }

    // 估算总内容长度（回复 + thinking + 每条目约 100 字符的轨迹）
    const totalContent = stats.responseTextLength + stats.thinkingTextLength + totalEntries * 100;

    // 内容过长 → 分割，避免撑爆飞书卡片（限制约 10000 字符，保守设 6000）
    if (totalContent > 6000) {
      return true;
    }

    // 时间线过长 → 分割（避免卡片滚动过长）
    if (stats.timelineLength > 10) {
      return true;
    }

    // 其他情况不分割（中等长度任务保持一个气泡）
    return false;
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