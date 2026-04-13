import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage, RenderedMessage } from '../../channels/types.js';
import { chunkByParagraph } from '../../delivery/delivery.js';
import type { MessageRendererState } from './renderer.js';
import { truncate } from '../../utils/string.js';
import { buildProgressData } from './progress-builder.js';

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
      const progressData = buildProgressData(state, this.inbound.text || '继续当前任务', castButtons(buttons), content);

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
    footerLine?: string;
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

    return {
      summary,
      changedFiles: changedFileKeys.size,
      permissionRequests: state.permissionRequests,
      hasError,
      footerLine: state.footerLine,
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
