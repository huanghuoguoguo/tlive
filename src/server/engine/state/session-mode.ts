import type { EffortLevel } from '../../../shared/providers/effort.js';

/** Session configuration stored per chat/session. */
export interface SessionMode {
  permissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  model?: string;
  effort?: EffortLevel;
  systemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
}
