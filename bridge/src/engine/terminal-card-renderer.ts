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
  parentToolUseId?: string;
}

interface AgentEntry {
  description: string;
  toolUseId?: string;
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
  onToolStart(name: string, input: Record<string, unknown>, parentToolUseId?: string): string {
    const id = `tool-${++this.toolIdCounter}`;
    const title = getToolTitle(name, input);
    const entry: ToolEntry = { id, name, title, running: true, denied: false, parentToolUseId };

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
  onAgentStart(description: string, toolUseId?: string): void {
    this.agents.push({ description, toolUseId, status: 'running' });
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
      // Auto-complete the agent's tool entry
      if (agent.toolUseId) {
        const toolEntry = this.findTool(agent.toolUseId);
        if (toolEntry) toolEntry.running = false;
      }
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
    // Only count top-level entries toward window size
    let topLevelCount = this.toolEntries.filter(e => !e.parentToolUseId).length;
    while (topLevelCount > this.windowSize) {
      // Remove the first top-level entry and any children that reference it
      const idx = this.toolEntries.findIndex(e => !e.parentToolUseId);
      if (idx === -1) break;
      const removed = this.toolEntries[idx];
      this.toolEntries.splice(idx, 1);
      // Remove children of the collapsed entry
      this.toolEntries = this.toolEntries.filter(e => e.parentToolUseId !== removed.id);
      this.collapsedCount++;
      topLevelCount--;
    }
  }

  private totalToolCount(): number {
    return this.collapsedCount + this.toolEntries.filter(e => !e.parentToolUseId).length;
  }

  render(): string {
    const parts: string[] = [];

    // Error
    if (this.errorMessage) {
      parts.push(`❌ Error: ${this.errorMessage}`);
      return this.applyPlatformLimit(redactSensitiveContent(parts.join('\n')));
    }

    // Tool section
    if (this.completed && this.totalToolCount() > 0) {
      // Collapse tool log on completion — but still show agent summaries
      parts.push(`● ... (${this.totalToolCount()} tools)`);
      for (const agent of this.agents) {
        if (agent.status !== 'running') {
          const icon = agent.status === 'completed' ? '●' : agent.status === 'failed' ? '❌' : '⏹';
          parts.push(`${icon} Agent: ${agent.summary ?? agent.description}`);
        }
      }
    } else {
      // Build parent→children map
      const childTools = new Map<string, ToolEntry[]>();
      const topLevel: ToolEntry[] = [];

      for (const entry of this.toolEntries) {
        if (entry.parentToolUseId) {
          const children = childTools.get(entry.parentToolUseId) || [];
          children.push(entry);
          childTools.set(entry.parentToolUseId, children);
        } else {
          topLevel.push(entry);
        }
      }

      // Collapsed count
      if (this.collapsedCount > 0) {
        parts.push(`+${this.collapsedCount} more tool uses`);
      }

      // Render top-level entries with nested children
      for (const entry of topLevel) {
        const agent = this.agents.find(a => a.toolUseId === entry.id);
        const children = childTools.get(entry.id) || [];
        const isAgentEntry = agent || children.length > 0;

        const icon = entry.running ? '🔄' : '●';
        parts.push(`${icon} ${entry.title}`);

        // Result preview for non-agent top-level tools
        if (entry.resultPreview && !isAgentEntry) {
          const lines = entry.resultPreview.split('\n');
          for (const line of lines) {
            parts.push(`├  ${line}`);
          }
        }

        // Render agent children
        if (isAgentEntry) {
          for (let i = 0; i < children.length; i++) {
            const child = children[i];
            const agentDone = agent && agent.status !== 'running';
            const isLast = i === children.length - 1 && !agentDone;
            const connector = isLast ? '│ └' : '│ ├';
            const childIcon = child.running ? '🔄 ' : '';
            parts.push(`${connector} ${childIcon}${child.title}`);
            if (child.resultPreview) {
              for (const line of child.resultPreview.split('\n')) {
                parts.push(`│   ${line}`);
              }
            }
          }
          // Agent completion summary
          if (agent && agent.status !== 'running') {
            const statusIcon = agent.status === 'completed' ? '✓' : agent.status === 'failed' ? '✗' : '⏹';
            const stats: string[] = [];
            if (agent.usage) {
              if (agent.usage.tool_uses > 0) stats.push(`${agent.usage.tool_uses} tool uses`);
              if (agent.usage.duration_ms > 0) stats.push(`${Math.round(agent.usage.duration_ms / 1000)}s`);
            }
            const summary = agent.summary || 'Done';
            parts.push(`│ └ ${statusIcon} ${summary}${stats.length ? ` · ${stats.join(' · ')}` : ''}`);
          }
        }
      }

      // Show agents without toolUseId (legacy/unlinked agents) as standalone headers
      for (const agent of this.agents) {
        if (agent.toolUseId) continue; // already rendered as part of tool tree
        if (agent.status === 'running') {
          let line = `🔄 Agent: ${agent.description}`;
          if (agent.lastTool) line += ` → ${getToolIcon(agent.lastTool)} ${agent.lastTool}`;
          if (agent.usage) line += ` (${agent.usage.tool_uses} tools, ${Math.round(agent.usage.duration_ms / 1000)}s)`;
          parts.push(line);
        } else {
          const statusIcon = agent.status === 'completed' ? '●' : agent.status === 'failed' ? '❌' : '⏹';
          parts.push(`${statusIcon} Agent: ${agent.summary ?? agent.description}`);
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
