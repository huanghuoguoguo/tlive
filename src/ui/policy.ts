export type ProgressPhase = 'starting' | 'executing' | 'waiting_permission' | 'completed' | 'failed';

export type PermissionDecision = 'allow' | 'allow_always' | 'deny';

export interface ProgressTraceStats {
  thinkingTextLength: number;
  timelineLength: number;
  thinkingEntries: number;
  toolEntries: number;
  responseTextLength: number;
}
