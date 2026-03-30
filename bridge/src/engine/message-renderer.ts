import { CostTracker, type UsageStats } from './cost-tracker.js';
import { redactSensitiveContent } from './content-filter.js';
import { getToolIcon } from './tool-registry.js';

export interface MessageRendererOptions {
  platformLimit: number;
  throttleMs?: number;
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

export class MessageRenderer {
  private toolCounts = new Map<string, number>();
  private totalTools = 0;
  private responseText = '';
  private completed = false;
  private costLine?: string;
  private errorMessage?: string;
  private pendingPermission?: PermissionState;

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

  get messageId(): string | undefined {
    return this._messageId;
  }

  constructor(options: MessageRendererOptions) {
    this.platformLimit = options.platformLimit;
    this.throttleMs = options.throttleMs ?? 300;
    this.flushCallback = options.flushCallback;
    this.onPermissionTimeout = options.onPermissionTimeout;
  }

  onToolStart(name: string): void {
    if (HIDDEN_TOOLS.has(name)) return;
    const current = this.toolCounts.get(name) ?? 0;
    this.toolCounts.set(name, current + 1);
    this.totalTools++;

    // Start elapsed timer on first tool
    if (!this.elapsedTimer) {
      this.elapsedTimer = setInterval(() => {
        this.elapsedSeconds++;
        this.scheduleFlush();
      }, 1000);
    }

    this.scheduleFlush();
  }

  onToolComplete(_toolUseId: string): void {
    // No-op — counter already incremented on start
  }

  onPermissionNeeded(
    toolName: string,
    input: string,
    permId: string,
    buttons: Array<{ label: string; callbackData: string; style: string }>,
  ): void {
    this.pendingPermission = { toolName, input, permId, buttons };
    this.clearPermissionTimeout();
    if (this.onPermissionTimeout) {
      this.permissionTimeoutTimer = setTimeout(() => {
        if (this.pendingPermission) {
          this.onPermissionTimeout!(
            this.pendingPermission.toolName,
            this.pendingPermission.input,
            this.pendingPermission.buttons,
          );
        }
      }, 60_000);
    }
    this.scheduleFlush();
  }

  onPermissionResolved(): void {
    this.clearPermissionTimeout();
    this.pendingPermission = undefined;
    this.scheduleFlush();
  }

  onTextDelta(text: string): void {
    this.responseText += text;
    // No flush during accumulation
  }

  onComplete(stats: UsageStats): void {
    this.completed = true;
    this.costLine = CostTracker.format(stats);
    this.stopTimers();
    const content = this.render();
    this.doFlush(content);
  }

  onError(error: string): void {
    this.errorMessage = error;
    this.stopTimers();
    const content = this.render();
    this.doFlush(content);
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

    // Permission phase — show full command (user needs to assess risk)
    if (this.pendingPermission) {
      const p = this.pendingPermission;
      return this.applyPlatformLimit(redactSensitiveContent(`🔐 ${p.toolName}: ${p.input}`));
    }

    // Done phase (completed or error with tools)
    if (this.completed || this.errorMessage) {
      return this.renderDone();
    }

    // Executing phase
    return this.renderExecuting();
  }

  private renderExecuting(): string {
    if (this.totalTools === 0) {
      return '⏳ Starting...';
    }
    const parts: string[] = [];
    for (const [name, count] of this.toolCounts) {
      parts.push(`${getToolIcon(name)} ${name} ×${count}`);
    }
    const toolSummary = parts.join(' · ');
    const elapsed = `${this.elapsedSeconds}s`;
    return this.applyPlatformLimit(
      redactSensitiveContent(`⏳ ${toolSummary} (${this.totalTools} tools · ${elapsed})`),
    );
  }

  private renderToolSummary(): string {
    const parts: string[] = [];
    for (const [name, count] of this.toolCounts) {
      parts.push(`${getToolIcon(name)} ${name} ×${count}`);
    }
    return `${parts.join(' · ')} (${this.totalTools} total)`;
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
      lines.push(this.renderToolSummary());
      return this.applyPlatformLimit(redactSensitiveContent(lines.join('\n')));
    }

    // Completed — no platform limit applied here; bridge-manager handles overflow chunking
    if (this.responseText) {
      lines.push(this.responseText);
      lines.push(SEPARATOR);
    }
    if (this.totalTools > 0) {
      lines.push(this.renderToolSummary());
    }
    if (this.costLine) {
      lines.push(this.costLine);
    }
    return redactSensitiveContent(lines.join('\n'));
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
    if (this.flushing) {
      this.pendingFlush = true;
      return;
    }
    this.flushing = true;
    try {
      const isEdit = !!this._messageId;
      const flushButtons = this.pendingPermission?.buttons;
      const result = await this.flushCallback(content, isEdit, flushButtons);
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
