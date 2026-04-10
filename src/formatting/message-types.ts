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
  permissionMode: 'on' | 'off';
  recentSummary?: string;
  recentSessions?: Array<{
    index: number;
    date: string;
    preview: string;
    isCurrent: boolean;
  }>;
}

/** Permission status card for /perm command */
export interface PermissionStatusData {
  mode: 'on' | 'off';
  rememberedTools: number;
  rememberedBashPrefixes: number;
  pending?: {
    toolName: string;
    input: string;
  };
  lastDecision?: {
    toolName: string;
    decision: 'allow' | 'allow_always' | 'deny' | 'cancelled';
  };
}

/** Task start confirmation card (session reset or new task) */
export interface TaskStartData {
  cwd: string;
  permissionMode: 'on' | 'off';
  isNewSession: boolean;
  previousSessionPreview?: string;
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
  /** Accumulated thinking/reasoning text */
  thinkingText?: string;
  /** Tool call history with input/result details */
  toolLogs?: Array<{ name: string; input: string; result?: string; isError?: boolean }>;
  /** Ordered interleaved timeline of thinking, text, and tool calls */
  timeline?: Array<{ kind: 'thinking' | 'text' | 'tool'; text?: string; toolName?: string; toolInput?: string; toolResult?: string; isError?: boolean }>;
  /** Completed Feishu flow: keep only trace panels in the progress bubble. */
  completedTraceOnly?: boolean;
  /** Override buttons (e.g., permission-specific). Formatters derive defaults from phase when absent. */
  actionButtons?: Button[];
  /** Number of permission prompts shown during this task. */
  permissionRequests?: number;
  /** True after bubble split — indicates continuation of previous task */
  isContinuation?: boolean;
}

/** Task completion summary card */
export interface TaskSummaryData {
  summary: string;
  changedFiles: number;
  permissionRequests: number;
  hasError: boolean;
  nextStep: string;
}

/** Card resolution state update (after button click) */
export interface CardResolutionData {
  resolution: 'approved' | 'denied' | 'skipped' | 'answered' | 'selected';
  /** Display label (e.g., "✅ Selected: Option A") */
  label: string;
  /** Optional context suffix (e.g., " Terminal" for AskUserQuestion) */
  contextSuffix?: string;
  /** Updated card text (for permission cards with original text) */
  originalText?: string;
  /** Buttons to show on resolved card (usually empty) */
  buttons?: Button[];
}

/** Version update notification */
export interface VersionUpdateData {
  current: string;
  latest: string;
  publishedAt?: string;
}

/** Multi-select toggle card (for AskUserQuestion) */
export interface MultiSelectToggleData {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  selectedIndices: Set<number>;
  permId: string;
  sessionId: string;
}

/** Union type of all formattable messages */
export type FormattableMessage =
  | { type: 'status'; chatId: string; data: StatusData }
  | { type: 'permission'; chatId: string; data: PermissionData }
  | { type: 'question'; chatId: string; data: QuestionData }
  | { type: 'notification'; chatId: string; data: NotificationData }
  | { type: 'home'; chatId: string; data: HomeData }
  | { type: 'permissionStatus'; chatId: string; data: PermissionStatusData }
  | { type: 'taskStart'; chatId: string; data: TaskStartData }
  | { type: 'sessions'; chatId: string; data: SessionsData }
  | { type: 'sessionDetail'; chatId: string; data: SessionDetailData }
  | { type: 'help'; chatId: string; data: HelpData }
  | { type: 'newSession'; chatId: string; data: NewSessionData }
  | { type: 'error'; chatId: string; data: ErrorData }
  | { type: 'progress'; chatId: string; data: ProgressData }
  | { type: 'taskSummary'; chatId: string; data: TaskSummaryData }
  | { type: 'cardResolution'; chatId: string; data: CardResolutionData }
  | { type: 'versionUpdate'; chatId: string; data: VersionUpdateData }
  | { type: 'multiSelectToggle'; chatId: string; data: MultiSelectToggleData };
