/**
 * Semantic message types for cross-platform formatting.
 * Upper layers use these types; adapters handle platform-specific rendering.
 */

import type { Button } from '../channels/types.js';

/** Status display for /status command */
export interface StatusData {
  healthy: boolean;
  channels: string[];
  cwd?: string;
  sessionId?: string;
}

/** Permission request card */
export interface PermissionData {
  toolName: string;
  toolInput: string;
  permissionId: string;
  expiresInMinutes?: number;
  terminalUrl?: string;
}

/** AskUserQuestion card */
export interface QuestionData {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  permId: string;
  sessionId: string;
}

/** Hook notification (stop, idle_prompt, etc.) */
export interface NotificationData {
  type: 'stop' | 'idle_prompt' | 'generic';
  title: string;
  summary?: string;
  terminalUrl?: string;
  sessionId?: string;
  cwd?: string;
}

/** Home screen for /home command */
export interface HomeData {
  cwd: string;
  hasActiveTask: boolean;
  recentSummary?: string;
}

/** Session list for /sessions command */
export interface SessionsData {
  sessions: Array<{
    index: number;
    date: string;
    cwd: string;
    size: string;
    preview: string;
    isCurrent: boolean;
  }>;
  filterHint: string;
}

/** Session detail for /sessioninfo command */
export interface SessionDetailData {
  index: number;
  cwd: string;
  preview: string;
  date: string;
  size: string;
  transcript: Array<{ role: string; text: string }>;
}

/** Help menu for /help command */
export interface HelpData {
  commands: Array<{ cmd: string; desc: string }>;
}

/** New session confirmation */
export interface NewSessionData {
  cwd?: string;
}

/** Error message */
export interface ErrorData {
  title: string;
  message: string;
}

/** Progress update (for streaming) */
export interface ProgressData {
  phase: 'starting' | 'executing' | 'waiting_permission' | 'completed' | 'failed';
  taskSummary: string;
  elapsedSeconds: number;
  currentTool?: { name: string; input: string; elapsed: number } | null;
  permission?: { toolName: string; input: string; queueLength: number };
  renderedText: string;
  todoItems: Array<{ content: string; status: string }>;
  footerLine?: string;
  totalTools: number;
  toolSummary?: string;
}

/** Union type of all formattable messages */
export type FormattableMessage =
  | { type: 'status'; chatId: string; data: StatusData }
  | { type: 'permission'; chatId: string; data: PermissionData }
  | { type: 'question'; chatId: string; data: QuestionData }
  | { type: 'notification'; chatId: string; data: NotificationData }
  | { type: 'home'; chatId: string; data: HomeData }
  | { type: 'sessions'; chatId: string; data: SessionsData }
  | { type: 'sessionDetail'; chatId: string; data: SessionDetailData }
  | { type: 'help'; chatId: string; data: HelpData }
  | { type: 'newSession'; chatId: string; data: NewSessionData }
  | { type: 'error'; chatId: string; data: ErrorData }
  | { type: 'progress'; chatId: string; data: ProgressData };

/** Helper to build buttons consistently */
export function buildButtons(items: Array<{ label: string; callbackData: string; style?: 'primary' | 'danger' | 'default'; url?: string; row?: number }>): Button[] {
  return items.map(item => ({
    label: item.label,
    callbackData: item.callbackData,
    style: item.style ?? 'default',
    url: item.url,
    row: item.row,
  }));
}