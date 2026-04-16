/**
 * Semantic message types for cross-platform formatting.
 * Upper layers use these types; adapters handle platform-specific rendering.
 */

import type { Button } from '../ui/types.js';

/** Session snapshot for /status detail */
export interface SessionSnapshot {
  sessionKey: string;
  workdir: string;
  isAlive: boolean;
  isTurnActive: boolean;
  lastActiveAt: number;
}

/** Managed session snapshot for /home display */
export interface ManagedSessionSnapshot {
  sessionKey: string;
  bindingSessionId: string;
  workdir: string;
  sdkSessionId?: string;
  isAlive: boolean;
  isTurnActive: boolean;
  lastActiveAt: number;
  isCurrent: boolean;
  queueDepth: number;
}

/** Status display for /status command */
export interface StatusData {
  healthy: boolean;
  channels: string[];
  /** Bot info per channel (name or ID) */
  channelInfo?: Array<{ type: string; name?: string; id?: string }>;
  cwd?: string;
  sessionId?: string;
  /** Active SDK sessions */
  activeSessions?: number;
  /** Idle SDK sessions */
  idleSessions?: number;
  /** Session detail snapshots */
  sessionSnapshots?: SessionSnapshot[];
  /** Memory usage string */
  memoryUsage?: string;
  /** Uptime in seconds */
  uptimeSeconds?: number;
  /** tlive version */
  version?: string;
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

/** Scanned session entry for home display */
export interface HomeSessionEntry {
  index: number;
  date: string;
  cwd: string;
  size?: string;
  preview: string;
  transcript?: Array<{ role: string; text: string }>;
  isCurrent: boolean;
  /** Whether this sdkSession is bound to another active bridge session */
  boundToActiveSession?: { channelType: string; chatId: string };
  isStale?: boolean;
}

/** Home screen for /home command */
export interface HomeData {
  workspace: {
    cwd: string;
    /** Workspace binding (long-term repo attribution) */
    binding?: string;
    /** Current project name (if multi-project mode) */
    project?: string;
  };
  task: {
    active: boolean;
  };
  session: {
    /** Current bridge session info */
    current?: {
      sessionId: string;
      sdkSessionId?: string;
      cwd: string;
      isActive: boolean;
      queueDepth?: number;
      lastActiveAt?: string;
    };
    /** Managed sessions in SDKEngine for this chat (in-memory active sessions) */
    managed?: ManagedSessionSnapshot[];
    /** Recent sessions in current workspace */
    recent?: HomeSessionEntry[];
    /** All sessions across all projects */
    all?: HomeSessionEntry[];
    /** Whether the current session is stale */
    stale?: boolean;
    /** Last active time (formatted string, e.g. "2小时前") */
    lastActiveAt?: string;
  };
  permission: {
    mode: 'on' | 'off';
    /** Pending permission request (if any) */
    pending?: { toolName: string; input: string };
    /** Last permission decision */
    lastDecision?: { toolName: string; decision: 'allow' | 'allow_always' | 'deny' | 'cancelled' };
    /** Number of remembered tools/Bash prefixes in session whitelist */
    whitelistCount?: number;
  };
  bridge: {
    /** Bridge connection status */
    healthy?: boolean;
    /** Active channels */
    channels?: string[];
    /** Queue info for active session */
    queueInfo?: { depth: number; max: number };
  };
  help?: {
    /** Help entries from command registry */
    entries?: Array<{ cmd: string; desc: string }>;
    /** Recent summary text */
    recentSummary?: string;
  };
  /** Recent projects for quick switch buttons */
  recentProjects?: Array<{
    name: string;
    workdir: string;
    /** Full workdir path for button callback (not shortened) */
    fullWorkdir: string;
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
  /** Reason for new session: 'idle' (auto-reset after inactivity), 'manual' (/new command), 'stale' (resume failed) */
  reason?: 'idle' | 'manual' | 'stale';
}

/** Session list for /sessions command */
export interface SessionsData {
  /** Current workspace binding for this chat */
  workspaceBinding?: string;
  sessions: Array<{
    index: number;
    date: string;
    cwd: string;
    size: string;
    preview: string;
    isCurrent: boolean;
    /** Whether this session is stale (inactive for too long) */
    isStale?: boolean;
  }>;
  filterHint: string;
  /** Whether this is showing all sessions (global) or current workspace only */
  showAll?: boolean;
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
  /** Optional feedback text (e.g., "已关闭旧会话") */
  feedbackText?: string;
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
  /** Session info from SDK init (skills, MCP servers, tools) */
  sessionInfo?: {
    tools?: string[];
    mcpServers?: Array<{ name: string; status: string }>;
    skills?: string[];
  };
  /** AI-generated summary of preceding tool calls */
  toolUseSummaryText?: string;
  /** API retry state */
  apiRetry?: {
    attempt: number;
    maxRetries: number;
    retryDelayMs: number;
    error?: string;
  };
  /** Context compaction indicator */
  compacting?: boolean;
}

/** Task completion summary card */
export interface TaskSummaryData {
  summary: string;
  changedFiles: number;
  permissionRequests: number;
  hasError: boolean;
  /** Footer line with model, cwd, sessionId (e.g., '[claude-sonnet] │ ~/workspace │ #ea22') */
  footerLine?: string;
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

/** Queue status for /queue command */
export interface QueueStatusData {
  sessionKey: string;
  depth: number;
  maxDepth: number;
  /** Preview of queued messages (if available) */
  queuedMessages?: Array<{ preview: string; timestamp: number }>;
  /** Estimated wait time in seconds (if calculable) */
  estimatedWaitSeconds?: number;
  /** Age of the oldest queued message in seconds */
  oldestQueuedAgeSeconds?: number;
  /** Queue pressure ratio: depth/maxDepth (0-1+) */
  saturationRatio?: number;
}

/** Diagnose system status for /diagnose command */
export interface DiagnoseData {
  activeSessions: number;
  totalBubbleMappings: number;
  /** Queue statistics per session */
  queueStats: Array<{ sessionKey: string; depth: number; maxDepth: number }>;
  /** Total queued messages across all sessions */
  totalQueuedMessages: number;
  /** Memory usage (if available) */
  memoryUsage?: string;
  /** Processing chats count */
  processingChats: number;
  /** Idle sessions count */
  idleSessions: number;
  /** Number of sessions with full queue depth */
  saturatedSessions?: number;
  /** Overall queue utilization ratio (0-1+) */
  queueUtilizationRatio?: number;
  /** Session with highest queue pressure */
  busiestSession?: { sessionKey: string; depth: number; maxDepth: number };
}

/** Project list for /project command */
export interface ProjectListData {
  projects: Array<{
    name: string;
    workdir: string;
    isDefault: boolean;
    isCurrent: boolean;
  }>;
  defaultProject?: string;
  currentProject?: string;
  hasMultipleProjects?: boolean;
}

/** Recent projects for /project command (when no explicit projects configured) */
export interface RecentProjectsData {
  projects: Array<{
    name: string;
    workdir: string;
    /** Full workdir path for button callback (not shortened) */
    fullWorkdir: string;
    lastUsedAt: string;
    useCount: number;
    isCurrent: boolean;
  }>;
  currentCwd: string;
}

/** Project info for /project info command */
export interface ProjectInfoData {
  projectName: string;
  workdir: string;
  /** If true, this is an implicit project (derived from cwd, not from projects.json) */
  isImplicit?: boolean;
  /** Workspace binding (long-term repo attribution) */
  workspaceBinding?: string;
  /** If false, the project name is bound but the project config is missing */
  isValidProject?: boolean;
  channels?: string[];
  claudeSettingSources?: string[];
  isDefault?: boolean;
  isCurrent?: boolean;
}

/** Deferred tool input request (EnterPlanMode, EnterWorktree, etc.) */
export interface DeferredToolInputData {
  toolName: 'EnterPlanMode' | 'EnterWorktree' | string;
  /** Prompt/description shown to user */
  prompt: string;
  /** Permission ID for tracking */
  permId: string;
  /** Session ID context */
  sessionId: string;
  /** Whether text input is required (vs optional) */
  inputRequired?: boolean;
  /** Placeholder for text input */
  inputPlaceholder?: string;
  /** Default value suggestion */
  defaultValue?: string;
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
  | { type: 'multiSelectToggle'; chatId: string; data: MultiSelectToggleData }
  | { type: 'queueStatus'; chatId: string; data: QueueStatusData }
  | { type: 'diagnose'; chatId: string; data: DiagnoseData }
  | { type: 'projectList'; chatId: string; data: ProjectListData }
  | { type: 'projectInfo'; chatId: string; data: ProjectInfoData }
  | { type: 'recentProjects'; chatId: string; data: RecentProjectsData }
  | { type: 'deferredToolInput'; chatId: string; data: DeferredToolInputData };
