import { CostTracker, type UsageStats } from './cost-tracker.js';
import { redactSensitiveContent } from './content-filter.js';
import { getToolIcon, getToolTitle, getToolResultPreview } from './tool-registry.js';

export type VerboseLevel = 0 | 1;

export interface TerminalCardRendererOptions {
  verboseLevel: VerboseLevel;
  platformLimit: number;
  throttleMs?: number;
  windowSize?: number;
  flushCallback: (content: string, isEdit: boolean) => Promise<string | void>;
}

interface ToolEntry {
  id: string;
  name: string;
  title: string;
  running: boolean;
  denied: boolean;
  resultPreview?: string;
}

interface AgentEntry {
  description: string;
  lastTool?: string;
  usage?: { tool_uses: number; duration_ms: number };
  status: 'running' | 'completed' | 'failed' | 'stopped';
  summary?: string;
}

interface PermissionState {
  toolName: string;
  input: string;
  reason: string;
  buttons: Array<{ label: string; callbackData: string; style: string }>;
}

interface AskUserQuestionState {
  header: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  buttons: Array<{ label: string; callbackData: string; style: string }>;
}

const SEPARATOR = '━━━━━━━━━━━━━━━━━━';

export class TerminalCardRenderer {
  private toolEntries: ToolEntry[] = [];
  private collapsedCount = 0;
  private agents: AgentEntry[] = [];
  private pendingPermission?: PermissionState;
  private pendingQuestion?: AskUserQuestionState;
  private responseText = '';
  private costLine?: string;
  private completed = false;
  private errorMessage?: string;

  private _messageId?: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private verboseLevel: VerboseLevel;
  private platformLimit: number;
  private throttleMs: number;
  private windowSize: number;
  private flushCallback: (content: string, isEdit: boolean) => Promise<string | void>;
  private flushing = false;
  private pendingFlush = false;
  private toolIdCounter = 0;
  private pendingTool?: { entry: ToolEntry; timer: ReturnType<typeof setTimeout> };

  get messageId(): string | undefined {
    return this._messageId;
  }

  constructor(options: TerminalCardRendererOptions) {
    this.verboseLevel = options.verboseLevel;
    this.platformLimit = options.platformLimit;
    this.throttleMs = options.throttleMs ?? 300;
    this.windowSize = options.windowSize ?? 8;
    this.flushCallback = options.flushCallback;
  }

  // Tool log
  onToolStart(name: string, input: Record<string, unknown>): string {
    const id = `tool-${++this.toolIdCounter}`;
    const title = getToolTitle(name, input);
    const entry: ToolEntry = { id, name, title, running: true, denied: false };

    // Flush any previous pending tool first
    this.flushPendingTool();

    if (this.verboseLevel === 0) {
      // At verbose 0, just track the entry without display
      this.toolEntries.push(entry);
      this.enforceWindow();
      return id;
    }

    // Buffer for 250ms before displaying
    this.pendingTool = {
      entry,
      timer: setTimeout(() => {
        this.commitTool(this.pendingTool!.entry);
        this.pendingTool = undefined;
      }, 250),
    };

    return id;
  }

  onToolComplete(toolUseId: string, result?: string, isError?: boolean): void {
    // Check if the completing tool is still in the pending buffer
    if (this.pendingTool?.entry.id === toolUseId) {
      clearTimeout(this.pendingTool.timer);
      const entry = this.pendingTool.entry;
      entry.running = false;
      if (result) {
        const preview = getToolResultPreview(entry.name, result, isError);
        if (preview) entry.resultPreview = preview;
      }
      this.commitTool(entry);
      this.pendingTool = undefined;
      return;
    }

    // Normal path for already-displayed tools
    const entry = this.findTool(toolUseId);
    if (!entry) return;
    entry.running = false;
    if (result) {
      const preview = getToolResultPreview(entry.name, result, isError);
      if (preview) entry.resultPreview = preview;
    }
    if (this.verboseLevel > 0) this.scheduleFlush();
  }

  onToolDenied(toolUseId: string): void {
    if (this.pendingTool?.entry.id === toolUseId) {
      clearTimeout(this.pendingTool.timer);
      const entry = this.pendingTool.entry;
      entry.running = false;
      entry.denied = true;
      entry.resultPreview = '❌ Denied';
      this.commitTool(entry);
      this.pendingTool = undefined;
      return;
    }

    const entry = this.findTool(toolUseId);
    if (!entry) return;
    entry.running = false;
    entry.denied = true;
    entry.resultPreview = '❌ Denied';
    if (this.verboseLevel > 0) this.scheduleFlush();
  }

  // Agent nesting
  onAgentStart(description: string): void {
    this.agents.push({ description, status: 'running' });
    if (this.verboseLevel > 0) this.scheduleFlush();
  }

  onAgentProgress(description: string, lastTool?: string, usage?: { tool_uses: number; duration_ms: number }): void {
    const agent = this.agents.find(a => a.description === description && a.status === 'running');
    if (agent) {
      agent.lastTool = lastTool;
      agent.usage = usage;
    }
    if (this.verboseLevel > 0) this.scheduleFlush();
  }

  onAgentComplete(summary: string, status: 'completed' | 'failed' | 'stopped'): void {
    const agent = this.agents.find(a => a.status === 'running');
    if (agent) {
      agent.status = status;
      agent.summary = summary;
    }
    if (this.verboseLevel > 0) this.scheduleFlush();
  }

  // Permission inline
  onPermissionNeeded(
    toolName: string,
    input: string,
    reason: string,
    buttons: Array<{ label: string; callbackData: string; style: string }>,
  ): void {
    this.flushPendingTool(); // user needs context
    this.pendingPermission = { toolName, input, reason, buttons };
    this.scheduleFlush();
  }

  onPermissionResolved(): void {
    this.pendingPermission = undefined;
    this.scheduleFlush();
  }

  // AskUserQuestion inline
  onQuestionNeeded(
    header: string,
    question: string,
    options: Array<{ label: string; description?: string }>,
    multiSelect: boolean,
    buttons: Array<{ label: string; callbackData: string; style: string }>,
  ): void {
    this.pendingQuestion = { header, question, options, multiSelect, buttons };
    this.scheduleFlush();
  }

  onQuestionResolved(): void {
    this.pendingQuestion = undefined;
    this.scheduleFlush();
  }

  // Text streaming
  onTextDelta(text: string): void {
    this.responseText += text;
    if (this.verboseLevel > 0) this.scheduleFlush();
  }

  onComplete(stats: UsageStats): void {
    this.flushPendingTool();
    this.completed = true;
    this.costLine = CostTracker.format(stats);
    this.cancelTimer();
    const content = this.render();
    this.doFlush(content);
  }

  onError(error: string): void {
    this.flushPendingTool();
    this.errorMessage = error;
    this.cancelTimer();
    const content = this.render();
    this.doFlush(content);
  }

  // Utility
  getResponseText(): string {
    return this.responseText;
  }

  dispose(): void {
    this.flushPendingTool();
    this.cancelTimer();
  }

  // --- Internal ---

  private flushPendingTool(): void {
    if (!this.pendingTool) return;
    clearTimeout(this.pendingTool.timer);
    this.commitTool(this.pendingTool.entry);
    this.pendingTool = undefined;
  }

  private commitTool(entry: ToolEntry): void {
    this.toolEntries.push(entry);
    this.enforceWindow();
    if (this.verboseLevel > 0) this.scheduleFlush();
  }

  private findTool(id: string): ToolEntry | undefined {
    return this.toolEntries.find(e => e.id === id);
  }

  private enforceWindow(): void {
    while (this.toolEntries.length > this.windowSize) {
      this.toolEntries.shift();
      this.collapsedCount++;
    }
  }

  private totalToolCount(): number {
    return this.collapsedCount + this.toolEntries.length;
  }

  render(): string {
    const parts: string[] = [];

    // Error
    if (this.errorMessage) {
      parts.push(`❌ Error: ${this.errorMessage}`);
      return this.applyPlatformLimit(redactSensitiveContent(parts.join('\n')));
    }

    // Agent headers
    for (const agent of this.agents) {
      if (agent.status === 'running') {
        let line = `🔄 Agent: ${agent.description}`;
        if (agent.lastTool) line += ` → ${getToolIcon(agent.lastTool)} ${agent.lastTool}`;
        if (agent.usage) line += ` (${agent.usage.tool_uses} tools, ${Math.round(agent.usage.duration_ms / 1000)}s)`;
        parts.push(line);
      } else {
        const icon = agent.status === 'completed' ? '●' : agent.status === 'failed' ? '❌' : '⏹';
        parts.push(`${icon} Agent: ${agent.summary ?? agent.description}`);
      }
    }

    // Tool section
    if (this.completed && this.totalToolCount() > 0) {
      // Collapse tool log on completion
      parts.push(`● ... (${this.totalToolCount()} tools)`);
    } else {
      // Collapsed count
      if (this.collapsedCount > 0) {
        parts.push(`+${this.collapsedCount} more tool uses`);
      }
      // Visible tool entries
      for (const entry of this.toolEntries) {
        const icon = entry.running ? '🔄' : '●';
        parts.push(`${icon} ${entry.title}`);
        if (entry.resultPreview) {
          const lines = entry.resultPreview.split('\n');
          for (const line of lines) {
            parts.push(`├  ${line}`);
          }
        }
      }
    }

    // Separator before permission/question/response
    const hasPermission = !!this.pendingPermission;
    const hasQuestion = !!this.pendingQuestion;
    const hasResponse = this.responseText.length > 0;
    const needsSeparator = hasPermission || hasQuestion || (this.completed && hasResponse);

    if (needsSeparator && parts.length > 0) {
      parts.push(SEPARATOR);
    }

    // Permission section
    if (hasPermission) {
      const p = this.pendingPermission!;
      parts.push(`🔐 ${p.toolName}`);
      parts.push(`  ${p.input}`);
      parts.push(`  ${p.reason}`);
    }

    // Question section
    if (hasQuestion && !hasPermission) {
      const q = this.pendingQuestion!;
      parts.push(`❓ ${q.header}: ${q.question}`);
      parts.push('');
      q.options.forEach((opt, i) => {
        let line = `${i + 1}. ${opt.label}`;
        if (opt.description) line += ` — ${opt.description}`;
        parts.push(line);
      });
    }

    // Text response
    if (hasResponse && !hasPermission && !hasQuestion) {
      parts.push(this.responseText);
    }

    // Cost line
    if (this.costLine) {
      parts.push(this.costLine);
    }

    return this.applyPlatformLimit(redactSensitiveContent(parts.join('\n')));
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

  private cancelTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
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
      const result = await this.flushCallback(content, isEdit);
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
