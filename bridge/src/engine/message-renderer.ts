import { redactSensitiveContent } from './content-filter.js';
import { getToolIcon } from './tool-registry.js';
import { homedir } from 'node:os';
import { truncate } from '../utils/string.js';
import { shortPath } from '../utils/path.js';

export interface MessageRendererOptions {
  platformLimit: number;
  throttleMs?: number;
  /** Working directory for footer display */
  cwd?: string;
  /** Model name for footer display */
  model?: string;
  /** Session ID for footer display (last 4 chars shown) */
  sessionId?: string;
  flushCallback: (
    content: string,
    isEdit: boolean,
    buttons?: Array<{ label: string; callbackData: string; style: string }>,
  ) => Promise<string | void>;
  /** Called when permission waits >60s without response */
  onPermissionTimeout?: (toolName: string, input: string, buttons: Array<{ label: string; callbackData: string; style: string }>) => void;
}

/** Tools silently ignored — never counted or displayed */
const HIDDEN_TOOLS = new Set([
  'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'TaskStop', 'TaskOutput', 'ToolSearch', 'TodoRead',
]);

const SEPARATOR = '───────────────';

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

export class MessageRenderer {
  private toolCounts = new Map<string, number>();
  private totalTools = 0;
  private responseText = '';
  private completed = false;
  private footerLine?: string;
  private errorMessage?: string;
  private permissionQueue: PermissionState[] = [];
  /** Currently executing tool for detailed progress */
  private currentTool: CurrentTool | null = null;

  private _messageId?: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private permissionTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private elapsedSeconds = 0;
  private platformLimit: number;
  private throttleMs: number;
  private flushCallback: MessageRendererOptions['flushCallback'];
  private onPermissionTimeout?: MessageRendererOptions['onPermissionTimeout'];
  private flushing = false;
  private pendingFlush = false;
  private cwd?: string;
  private model?: string;
  private sessionId?: string;
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
    this.cwd = options.cwd;
    this.model = options.model;
    this.sessionId = options.sessionId;
  }

  onToolStart(name: string, input?: Record<string, unknown>): void {
    if (HIDDEN_TOOLS.has(name)) return;
    const current = this.toolCounts.get(name) ?? 0;
    this.toolCounts.set(name, current + 1);
    this.totalTools++;

    // Set current tool for detailed progress
    this.currentTool = {
      name,
      input: this.formatToolInput(name, input),
      elapsed: 0,
    };

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
      default:
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

  onToolComplete(_toolUseId: string): void {
    // Clear current tool detail when done
    this.currentTool = null;
  }

  onPermissionNeeded(
    toolName: string,
    input: string,
    permId: string,
    buttons: Array<{ label: string; callbackData: string; style: string }>,
  ): void {
    this.permissionQueue.push({ toolName, input, permId, buttons });
    // Only start timeout for the first permission (the one being displayed)
    if (this.permissionQueue.length === 1) {
      this.startPermissionTimeout();
    }
    this.scheduleFlush();
  }

  onPermissionResolved(permId?: string): void {
    // Remove the resolved permission from queue
    if (permId) {
      const idx = this.permissionQueue.findIndex(p => p.permId === permId);
      if (idx !== -1) this.permissionQueue.splice(idx, 1);
    } else {
      // No permId: remove the head (currently displayed one)
      this.permissionQueue.shift();
    }
    // Restart timeout for next permission in queue
    this.clearPermissionTimeout();
    if (this.permissionQueue.length > 0) {
      this.startPermissionTimeout();
    }
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
      }, 60_000);
    }
  }

  onTextDelta(text: string): void {
    this.responseText += text;
    this.scheduleFlush();
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

  private renderExecuting(): string {
    if (this.totalTools === 0 && !this.responseText) {
      return '⏳ Starting...';
    }
    const lines: string[] = [];

    // Show response text above status line if available
    if (this.responseText.trim()) {
      lines.push(this.responseText.trim());
      lines.push('');
    }

    if (this.totalTools > 0) {
      const toolSummary = this.renderToolSummaryParts();
      const elapsed = `${this.elapsedSeconds}s`;
      lines.push(`⏳ ${toolSummary} (${this.totalTools} tools · ${elapsed})`);

      // Show current tool detail if available
      if (this.currentTool && this.currentTool.input) {
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

  private renderDone(): string {
    const lines: string[] = [];

    // Error with tools — show partial text + stopped + footer
    if (this.errorMessage) {
      if (this.responseText) {
        lines.push(this.responseText);
      }
      lines.push('⚠️ Stopped');
      lines.push(SEPARATOR);
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
    this.timer = setTimeout(() => {
      this.timer = null;
      const content = this.render();
      this.doFlush(content);
    }, this.throttleMs);
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
  }

  private clearPermissionTimeout(): void {
    if (this.permissionTimeoutTimer) {
      clearTimeout(this.permissionTimeoutTimer);
      this.permissionTimeoutTimer = null;
    }
  }

  private async doFlush(content: string): Promise<void> {
    if (!content) return;

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
      let result: string | void = undefined;
      try {
        result = await this.flushCallback(content, isEdit, flushButtons);
      } catch (err: any) {
        // Retry once for transient network errors
        const code = err?.code ?? '';
        const retryable = err?.retryable || ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET'].includes(code);
        if (retryable) {
          await new Promise(r => setTimeout(r, 1000));
          try {
            result = await this.flushCallback(content, isEdit, flushButtons);
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
    } finally {
      this.flushing = false;
      if (this.pendingFlush) {
        this.pendingFlush = false;
        const retryContent = this.render();
        if (retryContent) await this.doFlush(retryContent);
      }
    }
  }
}
