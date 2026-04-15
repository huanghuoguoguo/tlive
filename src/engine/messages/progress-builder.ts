/**
 * Progress content builder — renders plain-text progress messages.
 * Separated from MessageRenderer for cleaner architecture.
 */

import { redactSensitiveContent } from '../../utils/content-filter.js';
import { getToolIcon } from '../../utils/tool-registry.js';
import { shortPath } from '../../utils/path.js';
import type { TodoStatus } from '../../utils/types.js';
import type { MessageRendererState, TimelineEntry, ToolLogEntry } from './renderer.js';
import type { Button } from '../../ui/types.js';

const SEPARATOR = '───────────────';

/** Input state for rendering */
export interface RenderInput {
  phase: 'starting' | 'executing' | 'waiting_permission' | 'completed' | 'failed';
  responseText: string;
  thinkingText: string;
  elapsedSeconds: number;
  totalTools: number;
  toolCounts: Map<string, number>;
  bubbleToolCount: number;
  currentTool: { name: string; input: string; elapsed: number } | null;
  todoItems: Array<{ content: string; status: TodoStatus }>;
  toolLogs: ToolLogEntry[];
  timeline: TimelineEntry[];
  permissionQueue: Array<{
    toolName: string;
    input: string;
    permId: string;
    buttons: Button[];
  }>;
  permissionRequests: number;
  errorMessage?: string;
  completed: boolean;
  footerLine?: string;
  model?: string;
  cwd?: string;
  sessionId?: string;
  platformLimit: number;
  /** Session info from SDK init */
  sessionInfo?: {
    tools?: string[];
    mcpServers?: Array<{ name: string; status: string }>;
    skills?: string[];
  };
  /** AI-generated tool use summary */
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

export class ProgressContentBuilder {
  render(input: RenderInput): string {
    // Error without tools
    if (input.errorMessage && input.totalTools === 0) {
      return this.applyPlatformLimit(
        redactSensitiveContent(`❌ ${input.errorMessage}`),
        input.platformLimit
      );
    }

    // Permission phase — show queue head, full command
    if (input.permissionQueue.length > 0) {
      const p = input.permissionQueue[0];
      const queueHint = input.permissionQueue.length > 1
        ? `\n⏳ +${input.permissionQueue.length - 1} more pending`
        : '';
      return this.applyPlatformLimit(
        redactSensitiveContent(`🔐 ${p.toolName}: ${p.input}${queueHint}`),
        input.platformLimit
      );
    }

    // Done phase (completed or error with tools)
    if (input.completed || input.errorMessage) {
      return this.renderDone(input);
    }

    // Executing phase
    return this.renderExecuting(input);
  }

  getStateSnapshot(input: RenderInput, content: string): MessageRendererState {
    const currentPermission = input.permissionQueue[0];
    return {
      phase: input.permissionQueue.length > 0
        ? 'waiting_permission'
        : input.completed
          ? 'completed'
          : input.errorMessage
            ? 'failed'
            : input.totalTools === 0 && !input.responseText && input.todoItems.length === 0
              ? 'starting'
              : 'executing',
      renderedText: content,
      responseText: input.responseText,
      elapsedSeconds: input.elapsedSeconds,
      totalTools: input.totalTools,
      toolSummary: this.renderToolSummary(input),
      footerLine: input.footerLine,
      errorMessage: input.errorMessage,
      permissionRequests: input.permissionRequests,
      currentTool: input.currentTool,
      todoItems: input.todoItems,
      thinkingText: input.thinkingText,
      toolLogs: input.toolLogs,
      timeline: input.timeline,
      permission: currentPermission
        ? {
            toolName: currentPermission.toolName,
            input: currentPermission.input,
            queueLength: input.permissionQueue.length,
          }
        : undefined,
      isContinuation: input.bubbleToolCount === 0 && input.totalTools > 0,
      sessionInfo: input.sessionInfo,
      toolUseSummaryText: input.toolUseSummaryText,
      apiRetry: input.apiRetry,
      compacting: input.compacting,
    };
  }

  buildFooter(input: RenderInput): string {
    const parts: string[] = [];
    if (input.model) {
      parts.push(`[${input.model}]`);
    }
    if (input.cwd) {
      parts.push(shortPath(input.cwd));
    }
    if (input.sessionId) {
      const shortId = input.sessionId.length > 4 ? input.sessionId.slice(-4) : input.sessionId;
      parts.push(`#${shortId}`);
    }
    return parts.length > 0 ? parts.join(' │ ') : '';
  }

  // --- Private helpers ---

  private renderExecuting(input: RenderInput): string {
    // After bubble split: show continuation hint
    if (input.bubbleToolCount === 0 && input.totalTools > 0) {
      const lines: string[] = [];
      lines.push(`🔄 继续执行... (${input.totalTools} 步已完成)`);
      if (input.todoItems.length > 0) {
        lines.push('');
        lines.push(this.renderTodoProgress(input.todoItems));
      }
      if (input.currentTool?.input) {
        const elapsed = input.currentTool.elapsed > 0 ? ` (${input.currentTool.elapsed}s)` : '';
        lines.push(`   └─ ${input.currentTool.name}: ${input.currentTool.input}${elapsed}`);
      }
      return this.applyPlatformLimit(
        redactSensitiveContent(lines.join('\n')),
        input.platformLimit
      );
    }

    if (input.totalTools === 0 && !input.responseText && input.todoItems.length === 0) {
      return '⏳ Starting...';
    }

    const lines: string[] = [];

    if (input.responseText.trim()) {
      lines.push(input.responseText.trim());
      lines.push('');
    }

    if (input.todoItems.length > 0) {
      lines.push(this.renderTodoProgress(input.todoItems));
      lines.push('');
    }

    if (input.totalTools > 0) {
      const toolSummary = this.renderToolSummaryParts(input.toolCounts);
      const elapsed = `${input.elapsedSeconds}s`;
      lines.push(`⏳ ${toolSummary} (${input.totalTools} tools · ${elapsed})`);

      if (input.currentTool?.input) {
        const currentElapsed = input.currentTool.elapsed > 0 ? ` (${input.currentTool.elapsed}s)` : '';
        lines.push(`   └─ ${input.currentTool.name}: ${input.currentTool.input}${currentElapsed}`);
      }
    }

    return this.applyPlatformLimit(
      redactSensitiveContent(lines.join('\n')),
      input.platformLimit
    );
  }

  private renderDone(input: RenderInput): string {
    const lines: string[] = [];

    if (input.errorMessage) {
      if (input.responseText) {
        lines.push(input.responseText);
      }
      lines.push('⚠️ Stopped');
      lines.push(SEPARATOR);
      if (input.todoItems.length > 0) {
        lines.push(this.renderTodoProgress(input.todoItems));
        lines.push('');
      }
      if (input.totalTools > 0) {
        lines.push(this.renderToolSummary(input));
      }
      if (input.footerLine) {
        lines.push(input.footerLine);
      }
      return this.applyPlatformLimit(
        redactSensitiveContent(lines.join('\n')),
        input.platformLimit
      );
    }

    // Completed — no platform limit here
    if (input.responseText) {
      lines.push(input.responseText.trimEnd());
      lines.push(SEPARATOR);
    }
    if (input.todoItems.length > 0) {
      lines.push(this.renderTodoProgress(input.todoItems));
      lines.push('');
    }
    if (input.totalTools > 0) {
      lines.push(this.renderToolSummary(input));
    }
    if (input.footerLine) {
      lines.push(input.footerLine);
    }
    return redactSensitiveContent(lines.join('\n'));
  }

  private renderToolSummaryParts(toolCounts: Map<string, number>): string {
    const parts: string[] = [];
    for (const [name, count] of toolCounts) {
      parts.push(`${getToolIcon(name)} ${name} ×${count}`);
    }
    return parts.join(' · ');
  }

  private renderToolSummary(input: RenderInput): string {
    return `${this.renderToolSummaryParts(input.toolCounts)} (${input.totalTools} total)`;
  }

  private renderTodoProgress(todoItems: Array<{ content: string; status: TodoStatus }>): string {
    if (todoItems.length === 0) return '';
    const done = todoItems.filter(t => t.status === 'completed').length;
    const header = `📋 Progress (${done}/${todoItems.length})`;
    const lines = todoItems.map(t => {
      const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔧' : '⬜';
      return `${icon} ${t.content}`;
    });
    return `${header}\n${lines.join('\n')}`;
  }

  private applyPlatformLimit(content: string, limit: number): string {
    if (content.length > limit) {
      const tail = content.slice(-(limit - 100));
      return '...\n' + tail;
    }
    return content;
  }
}

import type { ProgressData } from '../../formatting/message-types.js';

/**
 * Build ProgressData from MessageRendererState.
 * Shared helper for query.ts and query-presenter.ts to avoid duplication.
 */
export function buildProgressData(
  state: MessageRendererState,
  taskSummary: string,
  buttons?: Button[],
  renderedTextOverride?: string,
): ProgressData {
  return {
    phase: state.phase,
    renderedText: renderedTextOverride ?? state.renderedText,
    taskSummary,
    elapsedSeconds: state.elapsedSeconds,
    totalTools: state.totalTools,
    toolSummary: state.toolSummary,
    footerLine: state.footerLine,
    currentTool: state.currentTool,
    permission: state.permission,
    permissionRequests: state.permissionRequests,
    todoItems: state.todoItems,
    thinkingText: state.thinkingText,
    toolLogs: state.toolLogs,
    timeline: state.timeline,
    isContinuation: state.isContinuation,
    sessionInfo: state.sessionInfo,
    toolUseSummaryText: state.toolUseSummaryText,
    apiRetry: state.apiRetry,
    compacting: state.compacting,
    actionButtons: buttons,
  };
}
