import { redactSensitiveContent } from './content-filter.js';
import { getToolIcon } from './tool-registry.js';
import { truncate } from '../utils/string.js';
import { shortPath } from '../utils/path.js';
import type { TodoStatus } from '../utils/types.js';
import type { VerboseLevel } from './session-state.js';

export interface MessageRendererOptions {
  platformLimit: number;
  throttleMs?: number;
  /** Working directory for footer display */
  cwd?: string;
  /** Model name for footer display */
  model?: string;
  /** Session ID for footer display (last 4 chars shown) */
  sessionId?: string;
  /** 0 = quiet, 1 = show executing status cards */
  verboseLevel?: VerboseLevel;
  flushCallback: (
    content: string,
    isEdit: boolean,
    buttons?: Array<{ label: string; callbackData: string; style: string }>,
    state?: MessageRendererState,
  ) => Promise<string | undefined>;
  /** Called when permission waits >60s without response */
  onPermissionTimeout?: (toolName: string, input: string, buttons: Array<{ label: string; callbackData: string; style: string }>) => void;
  /** Called when permission is first requested — add reaction to progress message */
  onPermissionReaction?: () => void;
  /** Called when all permissions resolved — remove permission reaction */
  onPermissionReactionClear?: () => void;
  /** Called when no progress for >30s during execution — add reaction to progress message */
  onProgressStalled?: () => void;
  /** Called when progress resumes after stall — remove reaction */
  onProgressResumed?: () => void;
}

/** Tools silently ignored — never counted or displayed */
const HIDDEN_TOOLS = new Set([
  'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'TaskStop', 'TaskOutput', 'ToolSearch', 'TodoRead',
]);

const SEPARATOR = '───────────────';

/** Timeout constants */
const PERMISSION_TIMEOUT_MS = 60_000;
const PROGRESS_TIMEOUT_MS = 30_000;
const PROGRESS_RESET_THROTTLE_MS = 5000;

/** Bubble split thresholds — send new message when exceeded */
const SPLIT_TOOL_THRESHOLD = 12;      // Split after N tools in current bubble
const SPLIT_TIMELINE_THRESHOLD = 18;  // Split after N timeline entries

interface PermissionState {
  toolName: string;
  input: string;
  permId: string;
  buttons: Array<{ label: string; callbackData: string; style: string }>;
}

/** Current tool execution state for progress display */
interface CurrentTool {
  name: string;
  input: string;  // Brief description of what's being done
  elapsed: number; // Seconds
}

/** Tool call log entry for detailed display */
export interface ToolLogEntry {
  name: string;
  input: string;
  result?: string;
  isError?: boolean;
}

/** Ordered timeline entry — interleaves text output with tool calls */
export interface TimelineEntry {
  kind: 'thinking' | 'text' | 'tool';
  /** For thinking/text entries */
  text?: string;
  /** For tool entries */
  toolName?: string;
  toolInput?: string;
  toolResult?: string;
  isError?: boolean;
}

export interface MessageRendererState {
  phase: 'starting' | 'executing' | 'waiting_permission' | 'completed' | 'failed';
  renderedText: string;
  responseText: string;
  elapsedSeconds: number;
  totalTools: number;
  toolSummary: string;
  footerLine?: string;
  errorMessage?: string;
  permissionRequests: number;
  currentTool: CurrentTool | null;
  todoItems: Array<{ content: string; status: TodoStatus }>;
  thinkingText: string;
  toolLogs: ToolLogEntry[];
  /** Ordered interleaved timeline of text + tool calls */
  timeline: TimelineEntry[];
  permission?: {
    toolName: string;
    input: string;
    queueLength: number;
  };
  /** True after bubble split — continuation of previous task */
  isContinuation?: boolean;
}

export class MessageRenderer {
  private toolCounts = new Map<string, number>();
  private totalTools = 0;
  /** Tools count in current bubble (reset on split) */
  private bubbleToolCount = 0;
  /** Timeline entries in current bubble (reset on split) */
  private bubbleTimelineCount = 0;
  private responseText = '';
  private completed = false;
  private footerLine?: string;
  private errorMessage?: string;
  private permissionQueue: PermissionState[] = [];
  private permissionRequests = 0;
  /** Currently executing tool for detailed progress */
  private currentTool: CurrentTool | null = null;
  /** Todo items for progress display */
  private todoItems: Array<{ content: string; status: TodoStatus }> = [];
  /** Accumulated thinking text */
  private thinkingText = '';
  /** Tool call history for detailed display */
  private toolLogs: ToolLogEntry[] = [];
  /** Map tool use ID to toolLogs index */
  private toolIdToLogIndex = new Map<string, number>();
  /** Ordered timeline — interleaves thinking, text, and tool entries */
  private timeline: TimelineEntry[] = [];
  /** Map tool use ID to timeline index (for updating results) */
  private toolIdToTimelineIndex = new Map<string, number>();
  /** Whether the last timeline entry is a text entry (for appending) */
  private lastTimelineIsText = false;
  /** Flag to split bubble on next flush */
  private splitPending = false;

  private _messageId?: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private permissionTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  /** Progress timeout timer for intermediate updates */
  private progressTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last progress timeout reset timestamp for throttling */
  private lastProgressReset = 0;
  /** Task summary for progress timeout message */
  private taskSummary = '';
  private elapsedSeconds = 0;
  private platformLimit: number;
  private throttleMs: number;
  private flushCallback: MessageRendererOptions['flushCallback'];
  private onPermissionTimeout?: MessageRendererOptions['onPermissionTimeout'];
  private onPermissionReaction?: MessageRendererOptions['onPermissionReaction'];
  private onPermissionReactionClear?: MessageRendererOptions['onPermissionReactionClear'];
  private flushing = false;
  private pendingFlush = false;
  private cwd?: string;
  private model?: string;
  private sessionId?: string;
  private verboseLevel: VerboseLevel;
  private onProgressStalled?: MessageRendererOptions['onProgressStalled'];
  private onProgressResumed?: MessageRendererOptions['onProgressResumed'];
  /** Whether progress is currently stalled (reaction added) */
  private progressStalled = false;
  /** Last rendered content - for change detection */
  private lastRenderedContent = '';
  /** Force next flush regardless of content change */
  private forceFlush = false;
  /** Last flush timestamp - for rate limiting elapsed updates */
  private lastFlushTime = 0;
  /** Minimum interval between elapsed-only updates (ms) */
  private readonly elapsedUpdateInterval = 3000;

  get messageId(): string | undefined {
    return this._messageId;
  }

  constructor(options: MessageRendererOptions) {
    this.platformLimit = options.platformLimit;
    this.throttleMs = options.throttleMs ?? 300;
    this.flushCallback = options.flushCallback;
    this.onPermissionTimeout = options.onPermissionTimeout;
    this.onPermissionReaction = options.onPermissionReaction;
    this.onPermissionReactionClear = options.onPermissionReactionClear;
    this.onProgressStalled = options.onProgressStalled;
    this.onProgressResumed = options.onProgressResumed;
    this.cwd = options.cwd;
    this.model = options.model;
    this.sessionId = options.sessionId;
    this.verboseLevel = options.verboseLevel ?? 1;
  }

  onThinkingDelta(text: string): void {
    this.thinkingText += text;
    // Append to timeline: merge into existing thinking entry or create new one
    const last = this.timeline[this.timeline.length - 1];
    if (last?.kind === 'thinking') {
      last.text = (last.text || '') + text;
    } else {
      this.bubbleTimelineCount++;
      this.timeline.push({ kind: 'thinking', text });
    }
    this.lastTimelineIsText = false;
    // Check for split threshold on thinking entries too
    if (this._messageId && !this.splitPending && !this.completed &&
        this.bubbleTimelineCount >= SPLIT_TIMELINE_THRESHOLD) {
      this.splitPending = true;
    }
    // Force flush: plain-text render() doesn't include thinking, but Feishu
    // card uses state.timeline which has changed. Without forceFlush, the
    // change detection sees unchanged plain text and skips the flush.
    this.forceFlush = true;
    this.scheduleFlush();
  }

  onToolStart(name: string, input?: Record<string, unknown>, toolUseId?: string): void {
    if (HIDDEN_TOOLS.has(name)) return;
    const current = this.toolCounts.get(name) ?? 0;
    this.toolCounts.set(name, current + 1);
    this.totalTools++;
    this.bubbleToolCount++;

    // Set current tool for detailed progress
    this.currentTool = {
      name,
      input: this.formatToolInput(name, input),
      elapsed: 0,
    };

    // Record tool log entry
    const logIndex = this.toolLogs.length;
    this.toolLogs.push({ name, input: this.formatToolInput(name, input) });
    if (toolUseId) {
      this.toolIdToLogIndex.set(toolUseId, logIndex);
    }

    // Add to timeline
    const tlIdx = this.timeline.length;
    this.bubbleTimelineCount++;
    this.timeline.push({
      kind: 'tool',
      toolName: name,
      toolInput: this.formatToolInput(name, input),
    });
    if (toolUseId) {
      this.toolIdToTimelineIndex.set(toolUseId, tlIdx);
    }
    this.lastTimelineIsText = false;

    // Start elapsed timer on first tool
    if (!this.elapsedTimer) {
      this.elapsedTimer = setInterval(() => {
        this.elapsedSeconds++;
        if (this.currentTool) {
          this.currentTool.elapsed++;
        }
        // Only schedule flush every 3 seconds to reduce API calls
        if (this.elapsedSeconds % 3 === 0) {
          this.scheduleFlush();
        }
      }, 1000);
    }

    // Start progress timeout for intermediate updates
    this.resumeProgress();
    this.startProgressTimeout();

    // Check for bubble split threshold
    if (this._messageId && !this.splitPending && !this.completed &&
        (this.bubbleToolCount >= SPLIT_TOOL_THRESHOLD ||
         this.bubbleTimelineCount >= SPLIT_TIMELINE_THRESHOLD)) {
      this.splitPending = true;
    }

    this.forceFlush = true; // Force update on new tool
    this.scheduleFlush();
  }

  /** Update progress for currently running tool (e.g., elapsed time for Bash) */
  onToolProgress(data: { toolName: string; elapsed: number }): void {
    if (HIDDEN_TOOLS.has(data.toolName)) return;
    if (this.currentTool && this.currentTool.name === data.toolName) {
      this.currentTool.elapsed = Math.floor(data.elapsed / 1000);
      // Don't force flush - let the 5-second interval handle it
    }
  }

  onTodoUpdate(todos: Array<{ content: string; status: TodoStatus }>): void {
    this.todoItems = todos;
    this.scheduleFlush();
  }

  /** Format tool input for brief display */
  private formatToolInput(name: string, input?: Record<string, unknown>): string {
    if (!input) return '';
    switch (name) {
      case 'Bash':
        return truncate(String(input.command || ''), 60);
      case 'Read':
        return shortPath(String(input.file_path || ''));
      case 'Edit':
      case 'Write':
        return shortPath(String(input.file_path || ''));
      case 'Grep':
        return `"${truncate(String(input.pattern || ''), 30)}" in ${input.path ? shortPath(String(input.path)) : 'files'}`;
      case 'Glob':
        return String(input.pattern || '');
      case 'WebFetch':
        return truncate(String(input.url || ''), 50);
      case 'Agent':
        return truncate(String(input.description || input.prompt || ''), 50);
      default: {
        // Show first meaningful field
        const keys = ['file_path', 'path', 'command', 'url', 'pattern', 'query'];
        for (const key of keys) {
          if (input[key]) {
            return truncate(String(input[key]), 50);
          }
        }
        return '';
      }
    }
  }

  onToolComplete(_toolUseId: string): void {
    // Clear current tool detail when done
    this.currentTool = null;
  }

  /** Record tool result content for detailed log display */
  onToolResult(toolUseId: string, content: string, isError: boolean): void {
    const logIndex = this.toolIdToLogIndex.get(toolUseId);
    if (logIndex !== undefined && logIndex < this.toolLogs.length) {
      const preview = isError
        ? `❌ ${truncate(content, 200)}`
        : truncate(content, 200);
      this.toolLogs[logIndex].result = preview;
      this.toolLogs[logIndex].isError = isError;
    }
    // Also update timeline entry
    const tlIdx = this.toolIdToTimelineIndex.get(toolUseId);
    if (tlIdx !== undefined && tlIdx < this.timeline.length) {
      const entry = this.timeline[tlIdx];
      entry.toolResult = isError ? `❌ ${truncate(content, 200)}` : truncate(content, 200);
      entry.isError = isError;
    }
    // Plain-text render() does not include tool result details, but rich card
    // state does. Force a flush so Feishu cards update as soon as output lands.
    this.forceFlush = true;
    this.scheduleFlush();
  }

  onPermissionNeeded(
    toolName: string,
    input: string,
    permId: string,
    buttons: Array<{ label: string; callbackData: string; style: string }>,
  ): void {
    this.permissionRequests++;
    this.permissionQueue.push({ toolName, input, permId, buttons });
    // Clear progress timeout during permission wait - user needs to act
    this.clearProgressTimeout();
    if (this.permissionQueue.length === 1) {
      this.startPermissionTimeout();
      // Add 🔐 reaction to notify user
      this.onPermissionReaction?.();
    }
    this.forceFlush = true;
    this.scheduleFlush();
  }

  onPermissionResolved(permId?: string): void {
    // Remove the resolved permission from queue
    if (permId) {
      const idx = this.permissionQueue.findIndex(p => p.permId === permId);
      if (idx !== -1) this.permissionQueue.splice(idx, 1);
    } else {
      this.permissionQueue.shift();
    }
    this.clearPermissionTimeout();
    if (this.permissionQueue.length > 0) {
      this.startPermissionTimeout();
    } else {
      // All permissions resolved — clear reaction, restart progress
      this.onPermissionReactionClear?.();
      this.startProgressTimeout();
    }
    this.forceFlush = true;
    this.scheduleFlush();
  }

  private startPermissionTimeout(): void {
    this.clearPermissionTimeout();
    if (this.onPermissionTimeout && this.permissionQueue.length > 0) {
      this.permissionTimeoutTimer = setTimeout(() => {
        const head = this.permissionQueue[0];
        if (head) {
          this.onPermissionTimeout!(head.toolName, head.input, head.buttons);
        }
      }, PERMISSION_TIMEOUT_MS);
    }
  }

  private startProgressTimeout(): void {
    this.clearProgressTimeout();
    if (this.onProgressStalled && !this.completed && !this.errorMessage) {
      this.progressTimeoutTimer = setTimeout(() => {
        if (!this.completed && !this.errorMessage && this.totalTools > 0 && !this.progressStalled) {
          this.progressStalled = true;
          this.onProgressStalled!();
        }
      }, PROGRESS_TIMEOUT_MS);
    }
  }

  private clearProgressTimeout(): void {
    if (this.progressTimeoutTimer) {
      clearTimeout(this.progressTimeoutTimer);
      this.progressTimeoutTimer = null;
    }
  }

  /** If stalled, notify that progress resumed and clear stalled flag */
  private resumeProgress(): void {
    if (this.progressStalled) {
      this.progressStalled = false;
      this.onProgressResumed?.();
    }
  }

  onTextDelta(text: string): void {
    this.responseText += text;
    // Append to timeline: merge into existing text entry or create new one
    if (this.lastTimelineIsText) {
      const last = this.timeline[this.timeline.length - 1];
      last.text = (last.text || '') + text;
    } else {
      this.timeline.push({ kind: 'text', text });
      this.lastTimelineIsText = true;
    }
    // Update task summary from first meaningful text (cache trim to avoid double call)
    if (!this.taskSummary) {
      const trimmed = this.responseText.trim();
      if (trimmed.length > 20) {
        this.taskSummary = truncate(trimmed, 100);
      }
    }
    // Throttle progress timeout reset to avoid timer churn on frequent deltas
    const now = Date.now();
    if (now - this.lastProgressReset >= PROGRESS_RESET_THROTTLE_MS) {
      this.lastProgressReset = now;
      this.resumeProgress();
      this.startProgressTimeout();
    }
    this.scheduleFlush();
  }

  setModel(model: string | undefined): void {
    if (this.model === model) return;
    this.model = model;
  }

  onComplete(): Promise<void> {
    this.completed = true;
    this.footerLine = this.buildFooter();
    this.stopTimers();
    const content = this.render();
    return this.doFlush(content);
  }

  onError(error: string): Promise<void> {
    this.errorMessage = error;
    this.stopTimers();
    const content = this.render();
    return this.doFlush(content);
  }

  getResponseText(): string {
    return this.responseText;
  }

  getDebugSnapshot(): { thinkingEntries: number; textEntries: number; toolEntries: number } {
    let thinkingEntries = 0;
    let textEntries = 0;
    let toolEntries = 0;
    for (const entry of this.timeline) {
      if (entry.kind === 'thinking') thinkingEntries++;
      else if (entry.kind === 'text') textEntries++;
      else if (entry.kind === 'tool') toolEntries++;
    }
    return { thinkingEntries, textEntries, toolEntries };
  }

  dispose(): void {
    this.stopTimers();
  }

  // --- Internal ---

  private render(): string {
    // Error without tools
    if (this.errorMessage && this.totalTools === 0) {
      return this.applyPlatformLimit(redactSensitiveContent(`❌ ${this.errorMessage}`));
    }

    // Permission phase — show queue head, full command (user needs to assess risk)
    if (this.permissionQueue.length > 0) {
      const p = this.permissionQueue[0];
      const queueHint = this.permissionQueue.length > 1
        ? `\n⏳ +${this.permissionQueue.length - 1} more pending`
        : '';
      return this.applyPlatformLimit(redactSensitiveContent(`🔐 ${p.toolName}: ${p.input}${queueHint}`));
    }

    // Done phase (completed or error with tools)
    if (this.completed || this.errorMessage) {
      return this.renderDone();
    }

    // Executing phase
    return this.renderExecuting();
  }

  private getStateSnapshot(content: string): MessageRendererState {
    const currentPermission = this.permissionQueue[0];
    return {
      phase: this.permissionQueue.length > 0
        ? 'waiting_permission'
        : this.completed
          ? 'completed'
          : this.errorMessage
            ? 'failed'
            : this.totalTools === 0 && !this.responseText && this.todoItems.length === 0
              ? 'starting'
              : 'executing',
      renderedText: content,
      responseText: this.responseText,
      elapsedSeconds: this.elapsedSeconds,
      totalTools: this.totalTools,
      toolSummary: this.renderToolSummary(),
      footerLine: this.footerLine,
      errorMessage: this.errorMessage,
      permissionRequests: this.permissionRequests,
      currentTool: this.currentTool,
      todoItems: [...this.todoItems],
      thinkingText: this.thinkingText,
      toolLogs: [...this.toolLogs],
      timeline: this.timeline.map(e => ({ ...e })),
      permission: currentPermission
        ? {
            toolName: currentPermission.toolName,
            input: currentPermission.input,
            queueLength: this.permissionQueue.length,
          }
        : undefined,
      isContinuation: this.bubbleToolCount === 0 && this.totalTools > 0,
    };
  }

  private renderExecuting(): string {
    // After bubble split: show continuation hint
    if (this.bubbleToolCount === 0 && this.totalTools > 0) {
      const lines: string[] = [];
      lines.push(`🔄 继续执行... (${this.totalTools} 步已完成)`);
      if (this.todoItems.length > 0) {
        lines.push('');
        lines.push(this.renderTodoProgress());
      }
      if (this.currentTool?.input) {
        const elapsed = this.currentTool.elapsed > 0 ? ` (${this.currentTool.elapsed}s)` : '';
        lines.push(`   └─ ${this.currentTool.name}: ${this.currentTool.input}${elapsed}`);
      }
      return this.applyPlatformLimit(redactSensitiveContent(lines.join('\n')));
    }

    if (this.totalTools === 0 && !this.responseText && this.todoItems.length === 0) {
      return '⏳ Starting...';
    }
    const lines: string[] = [];

    // Show response text above status line if available
    if (this.responseText.trim()) {
      lines.push(this.responseText.trim());
      lines.push('');
    }

    // Show todo progress
    if (this.todoItems.length > 0) {
      lines.push(this.renderTodoProgress());
      lines.push('');
    }

    if (this.totalTools > 0) {
      const toolSummary = this.renderToolSummaryParts();
      const elapsed = `${this.elapsedSeconds}s`;
      lines.push(`⏳ ${toolSummary} (${this.totalTools} tools · ${elapsed})`);

      // Show current tool detail if available
      if (this.currentTool?.input) {
        const currentElapsed = this.currentTool.elapsed > 0 ? ` (${this.currentTool.elapsed}s)` : '';
        lines.push(`   └─ ${this.currentTool.name}: ${this.currentTool.input}${currentElapsed}`);
      }
    }

    return this.applyPlatformLimit(redactSensitiveContent(lines.join('\n')));
  }

  private renderToolSummaryParts(): string {
    const parts: string[] = [];
    for (const [name, count] of this.toolCounts) {
      parts.push(`${getToolIcon(name)} ${name} ×${count}`);
    }
    return parts.join(' · ');
  }

  private renderToolSummary(): string {
    return `${this.renderToolSummaryParts()} (${this.totalTools} total)`;
  }

  private renderTodoProgress(): string {
    if (this.todoItems.length === 0) return '';
    const done = this.todoItems.filter(t => t.status === 'completed').length;
    const header = `📋 Progress (${done}/${this.todoItems.length})`;
    const lines = this.todoItems.map(t => {
      const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔧' : '⬜';
      return `${icon} ${t.content}`;
    });
    return `${header}\n${lines.join('\n')}`;
  }

  private renderDone(): string {
    const lines: string[] = [];

    // Error with tools — show partial text + stopped + footer
    if (this.errorMessage) {
      if (this.responseText) {
        lines.push(this.responseText);
      }
      lines.push('⚠️ Stopped');
      lines.push(SEPARATOR);
      if (this.todoItems.length > 0) {
        lines.push(this.renderTodoProgress());
        lines.push('');
      }
      if (this.totalTools > 0) {
        lines.push(this.renderToolSummary());
      }
      if (this.footerLine) {
        lines.push(this.footerLine);
      }
      return this.applyPlatformLimit(redactSensitiveContent(lines.join('\n')));
    }

    // Completed — no platform limit applied here; bridge-manager handles overflow chunking
    if (this.responseText) {
      // Ensure text ends cleanly before separator (strip trailing whitespace but keep content)
      lines.push(this.responseText.trimEnd());
      lines.push(SEPARATOR);
    }
    if (this.todoItems.length > 0) {
      lines.push(this.renderTodoProgress());
      lines.push('');
    }
    if (this.totalTools > 0) {
      lines.push(this.renderToolSummary());
    }
    if (this.footerLine) {
      lines.push(this.footerLine);
    }
    return redactSensitiveContent(lines.join('\n'));
  }

  private buildFooter(): string {
    const parts: string[] = [];
    if (this.model) {
      parts.push(`[${this.model}]`);
    }
    if (this.cwd) {
      parts.push(shortPath(this.cwd));
    }
    if (this.sessionId) {
      // Show last 4 chars of session ID
      const shortId = this.sessionId.length > 4 ? this.sessionId.slice(-4) : this.sessionId;
      parts.push(`#${shortId}`);
    }
    return parts.length > 0 ? parts.join(' │ ') : '';
  }

  private applyPlatformLimit(content: string): string {
    if (content.length > this.platformLimit) {
      const tail = content.slice(-(this.platformLimit - 100));
      return '...\n' + tail;
    }
    return content;
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    // First message not sent yet → flush immediately so user sees the card ASAP.
    // After that, throttle to reduce API calls.
    const delay = this._messageId ? this.throttleMs : 0;
    this.timer = setTimeout(() => {
      this.timer = null;
      const content = this.render();
      this.doFlush(content);
    }, delay);
  }

  private stopTimers(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
    this.clearPermissionTimeout();
    this.clearProgressTimeout();
  }

  private clearPermissionTimeout(): void {
    if (this.permissionTimeoutTimer) {
      clearTimeout(this.permissionTimeoutTimer);
      this.permissionTimeoutTimer = null;
    }
  }

  private shouldSkipFlush(state: MessageRendererState): boolean {
    if (this.verboseLevel !== 0) return false;
    return state.phase === 'starting' || state.phase === 'executing';
  }

  private async doFlush(content: string): Promise<void> {
    if (!content) return;
    const state = this.getStateSnapshot(content);
    if (this.shouldSkipFlush(state)) {
      return;
    }

    const now = Date.now();

    // Check if only elapsed time changed (rate limited to every 3s)
    if (!this.forceFlush) {
      const contentChanged = content !== this.lastRenderedContent;
      const timeSinceLastFlush = now - this.lastFlushTime;
      const elapsedOnlyUpdate = this.lastRenderedContent &&
        content.replace(/\d+s\)/, '') === this.lastRenderedContent.replace(/\d+s\)/, '');

      // Skip if only elapsed changed and not enough time passed
      if (elapsedOnlyUpdate && timeSinceLastFlush < this.elapsedUpdateInterval) {
        return;
      }

      // Skip if content unchanged
      if (!contentChanged) {
        return;
      }
    }

    if (this.flushing) {
      this.pendingFlush = true;
      // Don't update lastRenderedContent yet - will be updated when actually flushed
      return;
    }

    // Update tracking state
    this.lastRenderedContent = content;
    this.lastFlushTime = now;
    this.forceFlush = false;

    this.flushing = true;
    try {
      const isEdit = !!this._messageId;
      const flushButtons = this.permissionQueue[0]?.buttons;
      let result: string | undefined;
      try {
        result = await this.flushCallback(content, isEdit, flushButtons, state);
      } catch (err: any) {
        // Retry once for transient network errors
        const code = err?.code ?? '';
        const retryable = err?.retryable || ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET'].includes(code);
        if (retryable) {
          await new Promise(r => setTimeout(r, 1000));
          try {
            result = await this.flushCallback(content, isEdit, flushButtons, state);
          } catch {
            // give up after one retry
            console.error('[renderer] Failed to flush after retry:', err);
          }
        } else {
          console.error('[renderer] Failed to flush:', err);
        }
      }
      if (!isEdit && typeof result === 'string') {
        this._messageId = result;
      }

      // Ignore deferred split once the task has already finished, otherwise
      // completion/error flushes can spawn an extra empty continuation bubble.
      if (this.splitPending && (this.completed || this.errorMessage)) {
        this.splitPending = false;
      } else if (this.splitPending) {
        this.splitPending = false;
        const toolsAtSplit = this.bubbleToolCount;
        const timelineAtSplit = this.bubbleTimelineCount;
        this.resetBubbleState();
        this.pendingFlush = true; // Trigger new message
        console.log(`[renderer] Bubble split after ${toolsAtSplit} tools, ${timelineAtSplit} timeline entries`);
      }
    } finally {
      this.flushing = false;
      if (this.pendingFlush) {
        this.pendingFlush = false;
        const retryContent = this.render();
        if (retryContent) await this.doFlush(retryContent);
      }
    }
  }

  /** Reset bubble state for split — keep cumulative counts, clear per-bubble data */
  private resetBubbleState(): void {
    this._messageId = undefined; // Next flush will send new message
    this.timeline = [];
    this.toolLogs = [];
    this.toolIdToLogIndex.clear();
    this.toolIdToTimelineIndex.clear();
    this.thinkingText = '';
    this.responseText = '';
    this.lastTimelineIsText = false;
    this.bubbleToolCount = 0;
    this.bubbleTimelineCount = 0;
    this.lastRenderedContent = '';
  }
}
