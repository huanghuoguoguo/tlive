import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage, RenderedMessage } from '../../channels/types.js';
import { chunkByParagraph } from '../../delivery/delivery.js';
import type { ProgressData } from '../../formatting/message-types.js';
import type { MessageRendererState } from './renderer.js';
import { truncate } from '../../utils/string.js';

type ButtonStyle = 'primary' | 'danger' | 'default';
type RawButton = { label: string; callbackData: string; style: string };
type CastedButton = { label: string; callbackData: string; style: ButtonStyle };

/** Cast button style from string to typed union */
function castButtons(buttons?: RawButton[]): CastedButton[] | undefined {
  return buttons?.map(b => ({ ...b, style: b.style as ButtonStyle }));
}

interface QueryExecutionPresenterOptions {
  adapter: BaseChannelAdapter;
  inbound: InboundMessage;
  platformLimit: number;
  clearTyping: () => void;
  getMessageId: () => string | undefined;
}

export class QueryExecutionPresenter {
  private adapter: BaseChannelAdapter;
  private inbound: InboundMessage;
  private platformLimit: number;
  private clearTyping: () => void;
  private getMessageId: () => string | undefined;

  constructor(options: QueryExecutionPresenterOptions) {
    this.adapter = options.adapter;
    this.inbound = options.inbound;
    this.platformLimit = options.platformLimit;
    this.clearTyping = options.clearTyping;
    this.getMessageId = options.getMessageId;
  }

  async flush(
    content: string,
    isEdit: boolean,
    buttons?: Array<{ label: string; callbackData: string; style: string }>,
    state?: MessageRendererState,
  ): Promise<string | undefined> {
    if (state && !this.adapter.shouldRenderProgressPhase(state.phase)) {
      return;
    }

    let outMsg: RenderedMessage;
    if (state) {
      const progressData: ProgressData = {
        phase: state.phase,
        renderedText: content,
        taskSummary: this.inbound.text || '继续当前任务',
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
        actionButtons: castButtons(buttons),
      };

      if (state.phase === 'completed' && this.shouldSplitCompletedTrace(state)) {
        const traceMsg = this.adapter.format({
          type: 'progress',
          chatId: this.inbound.chatId,
          data: {
            ...progressData,
            renderedText: '',
            footerLine: undefined,
            completedTraceOnly: true,
          },
        });
        if (isEdit) {
          await this.adapter.editMessage(this.inbound.chatId, this.getMessageId()!, traceMsg);
        } else {
          const traceResult = await this.adapter.send(traceMsg);
          this.clearTyping();
          void traceResult;
        }

        const summaryMsg = this.adapter.format({
          type: 'taskSummary',
          chatId: this.inbound.chatId,
          data: this.buildTaskSummary(state),
        });
        await this.adapter.send(summaryMsg);
        return;
      }

      outMsg = this.adapter.format({ type: 'progress', chatId: this.inbound.chatId, data: progressData });
    } else {
      outMsg = this.adapter.formatContent(this.inbound.chatId, content, castButtons(buttons));
    }

    if (!isEdit) {
      const result = await this.adapter.send(outMsg);
      this.clearTyping();
      return result.messageId;
    }

    if (content.length > this.platformLimit) {
      const chunks = chunkByParagraph(content, this.platformLimit);
      await this.adapter.editMessage(
        this.inbound.chatId,
        this.getMessageId()!,
        this.adapter.formatContent(this.inbound.chatId, chunks[0]),
      );
      for (let i = 1; i < chunks.length; i++) {
        await this.adapter.send(this.adapter.formatContent(this.inbound.chatId, chunks[i]));
      }
      return;
    }

    await this.adapter.editMessage(this.inbound.chatId, this.getMessageId()!, outMsg);
  }

  async dispose(): Promise<void> {}

  private buildTaskSummary(state: {
    responseText: string;
    renderedText: string;
    toolLogs: Array<{ name: string; input: string }>;
    permissionRequests: number;
    errorMessage?: string;
  }): import('../../formatting/message-types.js').TaskSummaryData {
    const summarySource = (state.responseText || state.renderedText || '').trim();
    // Allow full summary for task completion (up to 5000 chars)
    const summary = truncate(summarySource || '任务已完成', 5000);
    const changedFileKeys = new Set(
      state.toolLogs
        .filter(log => ['Edit', 'Write', 'MultiEdit'].includes(log.name) && log.input.trim())
        .map(log => log.input.trim()),
    );
    const hasError = !!state.errorMessage;
    const nextStep = hasError
      ? '查看失败原因后继续追问，或重新发起一个更小的修改任务。'
      : changedFileKeys.size > 0
        ? '如果结果符合预期，可以继续追问、测试变更，或切回最近会话继续处理。'
        : '可以继续追问细节，或切回最近会话处理下一步任务。';

    return {
      summary,
      changedFiles: changedFileKeys.size,
      permissionRequests: state.permissionRequests,
      hasError,
      nextStep,
    };
  }

  private shouldSplitCompletedTrace(state: {
    thinkingText: string;
    timeline: Array<{ kind: 'thinking' | 'text' | 'tool' }>;
    responseText: string;
  }): boolean {
    let thinkingCount = 0;
    let toolCount = 0;
    for (const entry of state.timeline) {
      if (entry.kind === 'thinking') thinkingCount++;
      else if (entry.kind === 'tool') toolCount++;
    }
    return this.adapter.shouldSplitCompletedTrace({
      thinkingTextLength: state.thinkingText.trim().length,
      timelineLength: state.timeline.length,
      thinkingEntries: thinkingCount,
      toolEntries: toolCount,
      responseTextLength: state.responseText.trim().length,
    });
  }
}
