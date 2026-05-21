import type { PermissionDecision } from '../permissions/gateway.js';

export type ProgressPhase = 'starting' | 'executing' | 'waiting_permission' | 'completed' | 'failed';

export interface ProgressTraceStats {
  thinkingEntries: number;
  toolEntries: number;
  timelineLength: number;
  responseTextLength: number;
  thinkingTextLength: number;
}

export type { PermissionDecision } from '../permissions/gateway.js';

export interface ProgressPolicy {
  shouldRenderPhase(phase: ProgressPhase): boolean;
  shouldSplitCompletedTrace(stats: ProgressTraceStats): boolean;
}

export interface ReactionPolicy {
  processing: string;
  done: string;
  error: string;
  stalled: string;
  permission: string;
  getPermissionDecision(decision: PermissionDecision): string;
}

export interface FormatPolicy {
  formatCodeOutput(text: string): string;
}

export interface ChannelPolicy {
  locale: 'en' | 'zh';
  progress: ProgressPolicy;
  reactions: ReactionPolicy;
  format: FormatPolicy;
}
