/**
 * Semantic message types for cross-platform formatting.
 * Upper layers use these types; adapters handle platform-specific rendering.
 */

import type { Button } from '../ui/types.js';
import type { AgentProviderKind } from '../providers/kinds.js';
import type { ActionCallbackRoute } from '../core/callbacks.js';
import type { AgentProviderRuntimeMode } from '../providers/types.js';

export interface ChannelInfo {
  type: string;
  name?: string;
  appId?: string;
}

/** Session snapshot for /status detail */
export interface SessionSnapshot {
  sessionKey: string;
  workdir: string;
  isAlive: boolean;
  isTurnActive: boolean;
  lastActiveAt: number;
}

/** Status display for /status command */
export interface StatusData {
  healthy: boolean;
  channels: string[];
  /** Bot info per channel (name or ID) */
  channelInfo?: ChannelInfo[];
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

/** AskUserQuestion card */
export interface QuestionData {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  permId: string;
  sessionId: string;
}

/** Scanned session entry for home display */
export interface HomeSessionEntry {
  index: number;
  provider?: AgentProviderKind;
  providerDisplayName?: string;
  sdkSessionId?: string;
  date: string;
  cwd: string;
  size?: string;
  preview: string;
  transcript?: Array<{ role: string; text: string }>;
  isCurrent: boolean;
  topic?: {
    scopeId: string;
    threadId: string;
    updatedAt: string;
    isActive: boolean;
  };
  /** Whether this sdkSession is bound to another active bridge session */
  boundToActiveSession?: { channelType: string; chatId: string; provider?: AgentProviderKind };
  isStale?: boolean;
}

/** Topic-backed conversation entry for /home display. */
export interface HomeTopicEntry {
  index: number;
  sdkSessionId?: string;
  scopeId: string;
  threadId: string;
  cwd: string;
  title: string;
  preview: string;
  provider?: AgentProviderKind;
  providerDisplayName?: string;
  updatedAt: string;
  isCurrent: boolean;
  isActive: boolean;
}

export interface SessionListEntry {
  index: number;
  provider?: AgentProviderKind;
  providerDisplayName?: string;
  sdkSessionId?: string;
  date: string;
  cwd: string;
  title?: string;
  preview: string;
  transcript?: Array<{ role: string; text: string }>;
  isCurrent?: boolean;
  isActive?: boolean;
  actionLabel: string;
  actionStyle?: Button['style'];
}

export interface SessionListData {
  title: string;
  emptyText: string;
  entries: SessionListEntry[];
}

export interface HomeProviderEntry {
  kind: AgentProviderKind;
  displayName: string;
  available: boolean;
  isDefault: boolean;
  reason?: string;
}

/** Home screen for /home command */
export interface HomeData {
  providers?: {
    defaultKind: AgentProviderKind;
    available: HomeProviderEntry[];
    all: HomeProviderEntry[];
  };
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
    /** Recent Feishu topics bound to agent runtime sessions. */
    topics?: HomeTopicEntry[];
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
    /** Channel info (appId, name) for each active channel */
    channelInfo?: ChannelInfo[];
    /** Queue info for active session */
    queueInfo?: { depth: number; max: number };
  };
  help?: {
    /** Help entries from command registry */
    entries?: HelpCommandEntry[];
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
  route?: ActionCallbackRoute;
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

/** Help category display metadata. */
export interface HelpCategoryInfo {
  id: string;
  title: string;
  icon: string;
  order: number;
  expandedByDefault?: boolean;
}

/** Help command entry for /home and /help display. */
export interface HelpCommandEntry {
  cmd: string;
  desc: string;
  category: HelpCategoryInfo;
  detail?: string;
  example?: string;
}

/** Help menu for /help command */
export interface HelpData {
  commands: HelpCommandEntry[];
  actionButtons?: Button[];
}

/** Provider-aware command palette shown when a user sends "/" inside a topic. */
export interface TopicCommandPaletteData {
  provider: AgentProviderKind;
  providerDisplayName: string;
  cwd: string;
  sdkSessionId?: string;
  isActive: boolean;
  permissionMode: 'on' | 'off';
  route?: {
    scopeId?: string;
    threadId?: string;
    replyTargetMessageId?: string;
    replyInThread?: boolean;
  };
  capabilities: {
    runtimeMode: AgentProviderRuntimeMode;
    nativeSteer: boolean;
    nativeQueue: boolean;
    interactivePermissions: boolean;
    sessionResume: boolean;
    imageInputs: boolean;
  };
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
  timeline?: Array<{
    kind: 'thinking' | 'text' | 'tool';
    text?: string;
    toolName?: string;
    toolInput?: string;
    toolResult?: string;
    isError?: boolean;
  }>;
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
  /** Formatted usage/cost summary shown in run info. */
  usageSummary?: string;
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
  /** Footer line with model, cwd, sessionId. */
  footerLine?: string;
  /** Context-specific action buttons. Topic summaries should not show workbench/session controls. */
  actionButtons?: Button[];
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

/** Diagnose system status for /diagnose command */
export interface DiagnoseData {
  activeSessions: number;
  totalBubbleMappings: number;
  /** Persisted channel bindings on disk */
  persistedBindings?: number;
  /** Persisted topic sessions across all chats */
  persistedTopicSessions?: number;
  /** Persisted topic sessions for the current platform chat */
  persistedTopicSessionsInChat?: number;
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
  | { type: 'question'; chatId: string; data: QuestionData }
  | { type: 'home'; chatId: string; data: HomeData }
  | { type: 'permissionStatus'; chatId: string; data: PermissionStatusData }
  | { type: 'taskStart'; chatId: string; data: TaskStartData }
  | { type: 'help'; chatId: string; data: HelpData }
  | { type: 'sessionList'; chatId: string; data: SessionListData }
  | { type: 'topicCommandPalette'; chatId: string; data: TopicCommandPaletteData }
  | { type: 'newSession'; chatId: string; data: NewSessionData }
  | { type: 'error'; chatId: string; data: ErrorData }
  | { type: 'progress'; chatId: string; data: ProgressData }
  | { type: 'taskSummary'; chatId: string; data: TaskSummaryData }
  | { type: 'cardResolution'; chatId: string; data: CardResolutionData }
  | { type: 'versionUpdate'; chatId: string; data: VersionUpdateData }
  | { type: 'multiSelectToggle'; chatId: string; data: MultiSelectToggleData }
  | { type: 'diagnose'; chatId: string; data: DiagnoseData }
  | { type: 'deferredToolInput'; chatId: string; data: DeferredToolInputData };
