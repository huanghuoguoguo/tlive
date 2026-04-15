/**
 * Message renderer — collects state and coordinates flush for progress display.
 * Rendering logic delegated to ProgressContentBuilder.
 */

import { truncate } from '../../utils/string.js';
import type { TodoStatus } from '../../utils/types.js';
import type { VerboseLevel } from '../state/session-state.js';
import type { Button } from '../../ui/types.js';
import { ProgressContentBuilder } from './progress-builder.js';
import type { RenderInput } from './progress-builder.js';
import type { ToolLogEntry, TimelineEntry, CurrentTool, MessageRendererState } from './renderer-types.js';
import { PermissionTracker } from './permission-tracker.js';
import { ProgressWatcher } from './progress-watcher.js';
import { formatToolInput } from './tool-formatter.js';
// Re-export shared types for backwards compatibility
export type { ToolLogEntry, TimelineEntry, MessageRendererState } from './renderer-types.js';

export interface MessageRendererOptions {
  shouldSplitState?: (state: MessageRendererState) => boolean;
  platformLimit: number;
  throttleMs?: number;
  cwd?: string;
  model?: string;
  sessionId?: string;
  verboseLevel?: VerboseLevel;
  flushCallback: (
    content: string,
    isEdit: boolean,
    buttons?: Button[],
    state?: MessageRendererState,
  ) => Promise<string | undefined>;
  onPermissionTimeout?: (toolName: string, input: string, buttons: Button[]) => void;
  onPermissionReaction?: () => void;
  onPermissionReactionClear?: () => void;
  onProgressStalled?: () => void;
  onProgressResumed?: () => void;
  onFlushError?: (error: Error, context: { phase: string; contentPreview: string }) => void;
}

/** Tools silently ignored */
const HIDDEN_TOOLS = new Set([
  'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'TaskStop', 'TaskOutput', 'ToolSearch', 'TodoRead',
]);

/** Split thresholds */
const SPLIT_TOOL_THRESHOLD = 12;
const SPLIT_TIMELINE_THRESHOLD = 18;

export class MessageRenderer {
  // State collection
  private toolCounts = new Map<string, number>();
  private totalTools = 0;
  private bubbleToolCount = 0;
  private bubbleTimelineCount = 0;
  private responseText = '';
  private completed = false;
  private footerLine?: string;
  private errorMessage?: string;
  private currentTool: CurrentTool | null = null;
  private todoItems: Array<{ content: string; status: TodoStatus }> = [];
  private thinkingText = '';
  private toolLogs: ToolLogEntry[] = [];
  private toolIdToLogIndex = new Map<string, number>();
  private timeline: TimelineEntry[] = [];
  private toolIdToTimelineIndex = new Map<string, number>();
  private lastTimelineIsText = false;
  private splitPending = false;
  private sessionInfo?: { tools?: string[]; mcpServers?: Array<{ name: string; status: string }>; skills?: string[] };
  private toolUseSummaryText?: string;
  private apiRetryState?: { attempt: number; maxRetries: number; retryDelayMs: number; error?: string };
  private compacting = false;

  // Flush management
  private _messageId?: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private taskSummary = '';
  private elapsedSeconds = 0;
  private platformLimit: number;
  private throttleMs: number;
  private flushCallback: MessageRendererOptions['flushCallback'];
  private flushing = false;
  private pendingFlush = false;
  private cwd?: string;
  private model?: string;
  private sessionId?: string;
  private verboseLevel: VerboseLevel;
  private onFlushError?: MessageRendererOptions['onFlushError'];
  private shouldSplitState?: MessageRendererOptions['shouldSplitState'];
  private lastRenderedContent = '';
  private forceFlush = false;
  private lastFlushTime = 0;
  private elapsedUpdateInterval = 3000;

  // Extracted components
  private contentBuilder = new ProgressContentBuilder();
  private permissionTracker?: PermissionTracker;
  private progressWatcher?: ProgressWatcher;

  get messageId(): string | undefined {
    return this._messageId;
  }

  constructor(options: MessageRendererOptions) {
    this.shouldSplitState = options.shouldSplitState;
    this.platformLimit = options.platformLimit;
    this.throttleMs = options.throttleMs ?? 300;
    this.flushCallback = options.flushCallback;
    this.onFlushError = options.onFlushError;
    this.cwd = options.cwd;
    this.model = options.model;
    this.sessionId = options.sessionId;
    this.verboseLevel = options.verboseLevel ?? 1;

    // Always initialize permission tracker for queue management
    this.permissionTracker = new PermissionTracker({
      onTimeout: options.onPermissionTimeout ?? (() => {}),
      onReaction: options.onPermissionReaction ?? (() => {}),
      onReactionClear: options.onPermissionReactionClear ?? (() => {}),
    });

    // Initialize progress watcher if callbacks provided
    if (options.onProgressStalled) {
      this.progressWatcher = new ProgressWatcher({
        onStalled: options.onProgressStalled,
        onResumed: options.onProgressResumed ?? (() => {}),
      });
    }
  }

  onThinkingDelta(text: string): void {
    this.thinkingText += text;
    const last = this.timeline[this.timeline.length - 1];
    if (last?.kind === 'thinking') {
      last.text = (last.text || '') + text;
    } else {
      this.bubbleTimelineCount++;
      this.timeline.push({ kind: 'thinking', text });
    }
    this.lastTimelineIsText = false;
    this.updateSplitPending();
    this.forceFlush = true;
    this.scheduleFlush();
  }

  onToolStart(name: string, input?: Record<string, unknown>, toolUseId?: string): void {
    if (HIDDEN_TOOLS.has(name)) return;
    const current = this.toolCounts.get(name) ?? 0;
    this.toolCounts.set(name, current + 1);
    this.totalTools++;
    this.bubbleToolCount++;

    const formattedInput = formatToolInput(name, input);
    this.currentTool = { name, input: formattedInput, elapsed: 0 };

    const logIndex = this.toolLogs.length;
    this.toolLogs.push({ name, input: formattedInput });
    if (toolUseId) this.toolIdToLogIndex.set(toolUseId, logIndex);

    const tlIdx = this.timeline.length;
    this.bubbleTimelineCount++;
    this.timeline.push({ kind: 'tool', toolName: name, toolInput: formattedInput });
    if (toolUseId) this.toolIdToTimelineIndex.set(toolUseId, tlIdx);
    this.lastTimelineIsText = false;

    if (!this.elapsedTimer) {
      this.elapsedTimer = setInterval(() => {
        this.elapsedSeconds++;
        if (this.currentTool) this.currentTool.elapsed++;
        if (this.elapsedSeconds % 3 === 0) this.scheduleFlush();
      }, 1000);
    }

    this.progressWatcher?.resume();
    this.updateSplitPending();
    this.forceFlush = true;
    this.scheduleFlush();
  }

  onToolProgress(data: { toolName: string; elapsed: number }): void {
    if (HIDDEN_TOOLS.has(data.toolName)) return;
    if (this.currentTool && this.currentTool.name === data.toolName) {
      this.currentTool.elapsed = Math.floor(data.elapsed / 1000);
    }
  }

  onTodoUpdate(todos: Array<{ content: string; status: TodoStatus }>): void {
    this.todoItems = todos;
    this.updateSplitPending();
    this.scheduleFlush();
  }

  onSessionInfo(info: { tools?: string[]; mcpServers?: Array<{ name: string; status: string }>; skills?: string[] }): void {
    this.sessionInfo = info;
    this.forceFlush = true;
    this.scheduleFlush();
  }

  onToolUseSummary(summary: string): void {
    this.toolUseSummaryText = summary;
    this.forceFlush = true;
    this.scheduleFlush();
  }

  onApiRetry(data: { attempt: number; maxRetries: number; retryDelayMs: number; error?: string }): void {
    this.apiRetryState = data;
    this.forceFlush = true;
    this.scheduleFlush();
  }

  onApiRetryCleared(): void {
    this.apiRetryState = undefined;
  }

  onCompacting(active: boolean): void {
    this.compacting = active;
    this.forceFlush = true;
    this.scheduleFlush();
  }

  onToolComplete(_toolUseId: string): void {
    this.currentTool = null;
  }

  onToolResult(toolUseId: string, content: string, isError: boolean): void {
    const logIndex = this.toolIdToLogIndex.get(toolUseId);
    if (logIndex !== undefined && logIndex < this.toolLogs.length) {
      const preview = isError ? `❌ ${truncate(content, 200)}` : truncate(content, 200);
      this.toolLogs[logIndex].result = preview;
      this.toolLogs[logIndex].isError = isError;
    }
    const tlIdx = this.toolIdToTimelineIndex.get(toolUseId);
    if (tlIdx !== undefined && tlIdx < this.timeline.length) {
      const entry = this.timeline[tlIdx];
      entry.toolResult = isError ? `❌ ${truncate(content, 200)}` : truncate(content, 200);
      entry.isError = isError;
    }
    this.updateSplitPending();
    this.forceFlush = true;
    this.scheduleFlush();
  }

  onPermissionNeeded(toolName: string, input: string, permId: string, buttons: Button[]): void {
    this.progressWatcher?.clear();
    this.permissionTracker?.push(toolName, input, permId, buttons);
    this.forceFlush = true;
    this.scheduleFlush();
  }

  onPermissionResolved(permId?: string): void {
    this.permissionTracker?.resolve(permId);
    if (!this.permissionTracker || this.permissionTracker.getQueueLength() === 0) {
      this.progressWatcher?.start();
    }
    this.forceFlush = true;
    this.scheduleFlush();
  }

  onTextDelta(text: string): void {
    this.responseText += text;
    if (this.lastTimelineIsText) {
      const last = this.timeline[this.timeline.length - 1];
      last.text = (last.text || '') + text;
    } else {
      this.timeline.push({ kind: 'text', text });
      this.lastTimelineIsText = true;
    }
    if (!this.taskSummary) {
      const trimmed = this.responseText.trim();
      if (trimmed.length > 20) this.taskSummary = truncate(trimmed, 100);
    }
    this.progressWatcher?.resume();
    this.updateSplitPending();
    this.scheduleFlush();
  }

  setModel(model: string | undefined): void {
    if (this.model === model) return;
    this.model = model;
  }

  onComplete(): Promise<void> {
    this.completed = true;
    this.footerLine = this.contentBuilder.buildFooter(this.getRenderInput());
    this.stopTimers();
    const content = this.contentBuilder.render(this.getRenderInput());
    return this.doFlush(content);
  }

  onError(error: string): Promise<void> {
    this.errorMessage = error;
    this.stopTimers();
    const content = this.contentBuilder.render(this.getRenderInput());
    return this.doFlush(content);
  }

  getResponseText(): string {
    return this.responseText;
  }

  getDebugSnapshot(): { thinkingEntries: number; textEntries: number; toolEntries: number } {
    let thinkingEntries = 0, textEntries = 0, toolEntries = 0;
    for (const entry of this.timeline) {
      if (entry.kind === 'thinking') thinkingEntries++;
      else if (entry.kind === 'text') textEntries++;
      else if (entry.kind === 'tool') toolEntries++;
    }
    return { thinkingEntries, textEntries, toolEntries };
  }

  dispose(): void {
    this.stopTimers();
    this.permissionTracker?.dispose();
    this.progressWatcher?.dispose();
  }

  // --- Internal ---

  private getRenderInput(): RenderInput {
    const permissionQueue = this.permissionTracker?.getQueue() ?? [];
    return {
      phase: permissionQueue.length > 0 ? 'waiting_permission'
        : this.completed ? 'completed'
        : this.errorMessage ? 'failed'
        : this.totalTools === 0 && !this.responseText && this.todoItems.length === 0 ? 'starting'
        : 'executing',
      responseText: this.responseText,
      thinkingText: this.thinkingText,
      elapsedSeconds: this.elapsedSeconds,
      totalTools: this.totalTools,
      toolCounts: this.toolCounts,
      bubbleToolCount: this.bubbleToolCount,
      currentTool: this.currentTool,
      todoItems: this.todoItems,
      toolLogs: this.toolLogs,
      timeline: this.timeline,
      permissionQueue,
      permissionRequests: this.permissionTracker?.getRequestCount() ?? 0,
      errorMessage: this.errorMessage,
      completed: this.completed,
      footerLine: this.footerLine,
      model: this.model,
      cwd: this.cwd,
      sessionId: this.sessionId,
      platformLimit: this.platformLimit,
      sessionInfo: this.sessionInfo,
      toolUseSummaryText: this.toolUseSummaryText,
      apiRetry: this.apiRetryState,
      compacting: this.compacting,
    };
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    const delay = this._messageId ? this.throttleMs : 0;
    this.timer = setTimeout(() => {
      this.timer = null;
      const content = this.contentBuilder.render(this.getRenderInput());
      this.doFlush(content);
    }, delay);
  }

  private stopTimers(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.elapsedTimer) { clearInterval(this.elapsedTimer); this.elapsedTimer = null; }
    this.permissionTracker?.dispose();
    this.progressWatcher?.dispose();
  }

  private shouldSkipFlush(state: MessageRendererState): boolean {
    if (this.verboseLevel !== 0) return false;
    return state.phase === 'starting' || state.phase === 'executing';
  }

  private async doFlush(content: string): Promise<void> {
    if (!content) return;
    const state = this.contentBuilder.getStateSnapshot(this.getRenderInput(), content);
    if (this.shouldSkipFlush(state)) return;

    const now = Date.now();
    if (!this.forceFlush) {
      const contentChanged = content !== this.lastRenderedContent;
      const timeSinceLastFlush = now - this.lastFlushTime;
      const elapsedOnlyUpdate = this.lastRenderedContent &&
        content.replace(/\d+s\)/, '') === this.lastRenderedContent.replace(/\d+s\)/, '');
      if (elapsedOnlyUpdate && timeSinceLastFlush < this.elapsedUpdateInterval) return;
      if (!contentChanged) return;
    }

    if (this.flushing) { this.pendingFlush = true; return; }

    this.lastRenderedContent = content;
    this.lastFlushTime = now;
    this.forceFlush = false;

    this.flushing = true;
    try {
      const isEdit = !!this._messageId;
      const flushButtons = this.permissionTracker?.getHead()?.buttons;
      let result: string | undefined;
      try {
        result = await this.flushCallback(content, isEdit, flushButtons, state);
      } catch (err: any) {
        const code = err?.code ?? '';
        const retryable = err?.retryable || ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET'].includes(code);
        const phase = this.errorMessage ? 'failed' : this.completed ? 'completed'
          : (this.permissionTracker?.getQueueLength() ?? 0) > 0 ? 'waiting_permission' : 'executing';
        const contentPreview = content.slice(0, 100);

        if (retryable) {
          await new Promise(r => setTimeout(r, 1000));
          try { result = await this.flushCallback(content, isEdit, flushButtons, state); }
          catch (_retryErr) { console.error('[renderer] Failed after retry:', err); this.onFlushError?.(err, { phase, contentPreview }); }
        } else {
          console.error('[renderer] Failed:', err);
          this.onFlushError?.(err, { phase, contentPreview });
        }
      }
      if (!isEdit && typeof result === 'string') this._messageId = result;

      if (this.splitPending && (this.completed || this.errorMessage)) {
        this.splitPending = false;
      } else if (this.splitPending) {
        this.splitPending = false;
        console.log(`[renderer] Bubble split after ${this.bubbleToolCount} tools, ${this.bubbleTimelineCount} timeline entries`);
        this.resetBubbleState();
        this.pendingFlush = true;
      }
    } finally {
      this.flushing = false;
      if (this.pendingFlush) {
        this.pendingFlush = false;
        const retryContent = this.contentBuilder.render(this.getRenderInput());
        if (retryContent) await this.doFlush(retryContent);
      }
    }
  }

  private resetBubbleState(): void {
    this._messageId = undefined;
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

  private updateSplitPending(): void {
    if (!this._messageId || this.splitPending || this.completed || this.errorMessage) return;
    if (this.shouldSplitBubble()) this.splitPending = true;
  }

  private shouldSplitBubble(): boolean {
    if (this.shouldSplitState) {
      const state = this.contentBuilder.getStateSnapshot(this.getRenderInput(), this.contentBuilder.render(this.getRenderInput()));
      return this.shouldSplitState(state);
    }
    return this.bubbleToolCount >= SPLIT_TOOL_THRESHOLD || this.bubbleTimelineCount >= SPLIT_TIMELINE_THRESHOLD;
  }
}