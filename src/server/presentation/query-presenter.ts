import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage, RenderedMessage } from '../channels/types.js';
import type { TaskSummaryData } from '../../shared/formatting/message-types.js';
import { chunkByParagraph } from '../../shared/formatting/text-chunk.js';
import type { MessageRendererState } from '../engine/messages/renderer.js';
import { truncate } from '../../shared/core/string.js';
import { buildProgressData } from '../engine/messages/progress-builder.js';
import type { Button } from '../../shared/ui/types.js';
import { t } from '../../shared/i18n/index.js';
import { withInboundReplyContext } from '../channels/reply-context.js';
import {
  conversationSurface,
  progressButtonsForSurface,
  taskSummaryButtonsForSurface,
} from '../engine/conversations/surface-policy.js';

/** Pass buttons through unchanged */
function castButtons(buttons?: Button[]): Button[] | undefined {
  return buttons;
}

interface QueryExecutionPresenterOptions {
  adapter: BaseChannelAdapter;
  inbound: InboundMessage;
  platformLimit: number;
  clearTyping: () => void;
  getMessageId: () => string | undefined;
  sessionKey?: string;
  onMessageId?: (messageId: string) => void;
}

export class QueryExecutionPresenter {
  private adapter: BaseChannelAdapter;
  private inbound: InboundMessage;
  private platformLimit: number;
  private clearTyping: () => void;
  private getMessageId: () => string | undefined;
  private sessionKey?: string;
  private onMessageId?: (messageId: string) => void;
  private surface: ReturnType<typeof conversationSurface>;

  constructor(options: QueryExecutionPresenterOptions) {
    this.adapter = options.adapter;
    this.inbound = options.inbound;
    this.platformLimit = options.platformLimit;
    this.clearTyping = options.clearTyping;
    this.getMessageId = options.getMessageId;
    this.sessionKey = options.sessionKey;
    this.onMessageId = options.onMessageId;
    this.surface = conversationSurface({
      threadId: this.inbound.threadId,
      scopeId: this.inbound.scopeId,
    });
  }

  async flush(
    content: string,
    isEdit: boolean,
    buttons?: Button[],
    state?: MessageRendererState,
  ): Promise<string | undefined> {
    if (state && !this.adapter.shouldRenderProgressPhase(state.phase)) {
      return;
    }

    let outMsg: RenderedMessage;
    if (state) {
      const _locale = this.adapter.getLocale();
      const actionButtons = buttons ?? this.defaultProgressActionButtons(state);
      const progressData = buildProgressData(
        state,
        this.inbound.text || t('format.continueTask'),
        castButtons(actionButtons),
        content,
      );

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
        const traceOutMsg = withInboundReplyContext(traceMsg, this.inbound);
        if (isEdit) {
          await this.adapter.editMessage(this.inbound.chatId, this.getMessageId()!, traceOutMsg);
        } else {
          const traceResult = await this.adapter.send(traceOutMsg);
          this.clearTyping();
          void traceResult;
        }

        const summaryMsg = this.adapter.format({
          type: 'taskSummary',
          chatId: this.inbound.chatId,
          data: this.buildTaskSummary(state),
        });
        await this.adapter.send(withInboundReplyContext(summaryMsg, this.inbound));
        return;
      }

      outMsg = this.adapter.format({
        type: 'progress',
        chatId: this.inbound.chatId,
        data: progressData,
      });
    } else {
      outMsg = this.adapter.formatContent(this.inbound.chatId, content, castButtons(buttons));
    }
    outMsg = withInboundReplyContext(outMsg, this.inbound);

    if (!isEdit) {
      const result = await this.adapter.send(outMsg);
      this.clearTyping();
      if (result.messageId) this.onMessageId?.(result.messageId);
      return result.messageId;
    }

    if (content.length > this.platformLimit) {
      const chunks = chunkByParagraph(content, this.platformLimit);
      await this.adapter.editMessage(
        this.inbound.chatId,
        this.getMessageId()!,
        withInboundReplyContext(
          this.adapter.formatContent(this.inbound.chatId, chunks[0]),
          this.inbound,
        ),
      );
      for (let i = 1; i < chunks.length; i++) {
        await this.adapter.send(
          withInboundReplyContext(
            this.adapter.formatContent(this.inbound.chatId, chunks[i]),
            this.inbound,
          ),
        );
      }
      return;
    }

    await this.adapter.editMessage(this.inbound.chatId, this.getMessageId()!, outMsg);
  }

  async dispose(): Promise<void> {}

  private defaultProgressActionButtons(state: MessageRendererState): Button[] | undefined {
    return progressButtonsForSurface(
      this.surface,
      state.phase,
      this.adapter.getLocale(),
      this.sessionKey,
    );
  }

  private buildTaskSummary(state: {
    responseText: string;
    renderedText: string;
    toolLogs: Array<{ name: string; input: string }>;
    permissionRequests: number;
    errorMessage?: string;
    footerLine?: string;
  }): TaskSummaryData {
    // Allow full summary for task completion (up to 5000 chars)
    const locale = this.adapter.getLocale();
    const summarySource = (state.responseText || '').trim();
    const summary = truncate(summarySource || t('format.taskCompleted'), 5000);
    const changedFileKeys = new Set(
      state.toolLogs
        .filter((log) => ['Edit', 'Write', 'MultiEdit'].includes(log.name) && log.input.trim())
        .map((log) => log.input.trim()),
    );
    const hasError = !!state.errorMessage;

    return {
      summary,
      changedFiles: changedFileKeys.size,
      permissionRequests: state.permissionRequests,
      hasError,
      footerLine: state.footerLine,
      actionButtons: taskSummaryButtonsForSurface(this.surface, locale),
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
