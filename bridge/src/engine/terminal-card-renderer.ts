import { CostTracker, type UsageStats } from './cost-tracker.js';
import { redactSensitiveContent } from './content-filter.js';
import { getToolTitle, getToolResultPreview } from './tool-registry.js';

export type VerboseLevel = 0 | 1;

export interface TerminalCardRendererOptions {
  verboseLevel: VerboseLevel;
  platformLimit: number;
  throttleMs?: number;
  windowSize?: number;
  flushCallback: (content: string, isEdit: boolean, buttons?: Array<{ label: string; callbackData: string; style: string }>) => Promise<string | void>;
}

interface ToolEntry {
  id: string;
  name: string;
  title: string;
  input?: Record<string, unknown>;
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

const _SEPARATOR = '━━━━━━━━━━━━━━━━━━'; // kept for reference, no longer used

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
    const entry: ToolEntry = { id, name, title, input, running: true, denied: false, parentToolUseId };

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
    // Error
    if (this.errorMessage) {
      return this.applyPlatformLimit(redactSensitiveContent(`❌ Error: ${this.errorMessage}`));
    }

    const toolLines: string[] = [];
    const afterLines: string[] = [];

    // === TOOL SECTION (goes inside code block) ===

    if (this.completed && this.totalToolCount() > 0) {
      toolLines.push(`⚡ ${this.totalToolCount()} tools`);
    } else {
      // Collapsed count
      if (this.collapsedCount > 0) {
        toolLines.push(`+${this.collapsedCount} more`);
      }

      // Build tree and render tool entries
      const childTools = new Map<string, ToolEntry[]>();
      const topLevel: ToolEntry[] = [];
      for (const entry of this.toolEntries) {
        if (entry.parentToolUseId) {
          const c = childTools.get(entry.parentToolUseId) || [];
          c.push(entry);
          childTools.set(entry.parentToolUseId, c);
        } else {
          topLevel.push(entry);
        }
      }

      for (const entry of topLevel) {
        const prefix = entry.running ? '🔄' : '●';
        toolLines.push(`${prefix} ${entry.title}`);

        // Result (non-agent top-level)
        const agent = this.agents.find(a => a.toolUseId === entry.id);
        const children = childTools.get(entry.id) || [];
        if (entry.resultPreview && !agent && children.length === 0) {
          for (const line of entry.resultPreview.split('\n')) {
            toolLines.push(`  → ${line}`);
          }
        }

        // Agent children
        if (agent || children.length > 0) {
          for (const child of children) {
            const cp = child.running ? '🔄 ' : '';
            toolLines.push(`  ↳ ${cp}${child.title}`);
            if (child.resultPreview) {
              for (const line of child.resultPreview.split('\n')) {
                toolLines.push(`    → ${line}`);
              }
            }
          }
          if (agent && agent.status !== 'running') {
            const icon = agent.status === 'completed' ? '✓' : '✗';
            const stats: string[] = [];
            if (agent.usage) {
              if (agent.usage.tool_uses > 0) stats.push(`${agent.usage.tool_uses} tool uses`);
              if (agent.usage.duration_ms > 0) stats.push(`${Math.round(agent.usage.duration_ms / 1000)}s`);
            }
            const summary = agent.summary || 'Done';
            toolLines.push(`  ↳ ${icon} ${summary}${stats.length ? ` · ${stats.join(' · ')}` : ''}`);
          }
        }
      }

      // Legacy agents
      for (const agent of this.agents) {
        if (agent.toolUseId) continue;
        if (agent.status === 'running') {
          let line = `🔄 ${agent.description}`;
          if (agent.lastTool) line += ` → ${agent.lastTool}`;
          if (agent.usage) line += ` (${agent.usage.tool_uses} tools, ${Math.round(agent.usage.duration_ms / 1000)}s)`;
          toolLines.push(line);
        } else {
          const icon = agent.status === 'completed' ? '●' : '❌';
          toolLines.push(`${icon} ${agent.summary ?? agent.description}`);
        }
      }
    }

    // === AFTER SECTION (outside code block) ===

    // Permission
    if (this.pendingPermission) {
      const p = this.pendingPermission;
      afterLines.push(`🔐 **${p.toolName}**`);
      if (p.input) afterLines.push(`\`${p.input.slice(0, 200)}\``);
      if (p.reason && p.reason !== p.toolName) afterLines.push(p.reason);
    }

    // Question
    if (this.pendingQuestion && !this.pendingPermission) {
      const q = this.pendingQuestion;
      afterLines.push(`❓ ${q.header}: ${q.question}`);
      afterLines.push('');
      q.options.forEach((opt, i) => {
        afterLines.push(`${i + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ''}`);
      });
    }

    // Text response
    if (this.responseText && !this.pendingPermission && !this.pendingQuestion) {
      afterLines.push(this.responseText);
    }

    // Cost
    if (this.costLine) {
      afterLines.push(this.costLine);
    }

    // === COMBINE ===
    const parts: string[] = [];

    if (toolLines.length > 0) {
      parts.push('```');
      parts.push(...toolLines);
      parts.push('```');
    }

    if (afterLines.length > 0) {
      if (parts.length > 0) parts.push(''); // blank line after code block
      parts.push(...afterLines);
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
      const buttons = this.pendingPermission?.buttons || this.pendingQuestion?.buttons;
      const result = await this.flushCallback(content, isEdit, buttons);
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
