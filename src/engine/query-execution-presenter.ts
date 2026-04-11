import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage, OutboundMessage } from '../channels/types.js';
import { chunkByParagraph } from '../delivery/delivery.js';
import type { ProgressData } from '../formatting/message-types.js';
import { downgradeHeadings } from '../markdown/feishu.js';
import type { MessageRendererState } from './message-renderer.js';
import { truncate } from '../utils/string.js';

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
  private streamingSession: import('../channels/types.js').StreamingCardSession | null = null;
  private streamingRetired = false;

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
    if (
      this.adapter.channelType === 'qqbot'
      && state
      && (state.phase === 'starting' || state.phase === 'executing')
    ) {
      return;
    }

    if (this.shouldUseStreamingCard(state, buttons)) {
      return this.flushStreamingCard(content, isEdit, state!);
    }

    await this.retireStreamingCard();

    let outMsg: OutboundMessage;
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
        actionButtons: buttons?.length
          ? buttons.map(button => ({ ...button, style: button.style as 'primary' | 'danger' | 'default' }))
          : undefined,
      };

      if (
        this.adapter.channelType === 'feishu'
        && state.phase === 'completed'
        && this.shouldSplitFeishuCompletion(state)
      ) {
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
      const castButtons = buttons?.length
        ? buttons.map(button => ({ ...button, style: button.style as 'primary' | 'danger' | 'default' }))
        : undefined;
      outMsg = this.adapter.formatContent(this.inbound.chatId, content, castButtons);
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

  async dispose(): Promise<void> {
    await this.retireStreamingCard();
  }

  private buildTaskSummary(state: {
    responseText: string;
    renderedText: string;
    toolLogs: Array<{ name: string; input: string }>;
    permissionRequests: number;
    errorMessage?: string;
  }): import('../formatting/message-types.js').TaskSummaryData {
    const summarySource = (state.responseText || state.renderedText || '').trim();
    const summary = truncate(summarySource || '任务已完成', 280);
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

  private shouldSplitFeishuCompletion(state: {
    thinkingText: string;
    timeline: Array<{ kind: 'thinking' | 'text' | 'tool' }>;
    responseText: string;
  }): boolean {
    const thinkingCount = state.timeline.filter(entry => entry.kind === 'thinking').length;
    const toolCount = state.timeline.filter(entry => entry.kind === 'tool').length;
    const hasLongTrace = state.thinkingText.trim().length > 80 || state.timeline.length >= 4;
    const hasMeaningfulTooling = toolCount >= 2 || (toolCount >= 1 && thinkingCount >= 1);
    const hasLongAnswer = state.responseText.trim().length > 200;
    return hasMeaningfulTooling || hasLongTrace || (toolCount >= 1 && hasLongAnswer);
  }

  private shouldUseStreamingCard(
    state?: MessageRendererState,
    buttons?: Array<{ label: string; callbackData: string; style: string }>,
  ): boolean {
    if (this.streamingRetired) return false;
    if (this.adapter.channelType !== 'feishu') return false;
    if (!state) return false;
    if (buttons?.length) return false;
    return state.phase === 'starting' || state.phase === 'executing';
  }

  private async flushStreamingCard(
    content: string,
    isEdit: boolean,
    state: MessageRendererState,
  ): Promise<string | undefined> {
    const session = this.getOrCreateStreamingCard(state);
    if (!session) {
      this.streamingRetired = true;
      return undefined;
    }
    const markdown = downgradeHeadings(content);
    if (!isEdit) {
      const messageId = await session.start(markdown);
      this.clearTyping();
      return messageId;
    }
    await session.update(markdown);
    return;
  }

  private getOrCreateStreamingCard(
    state: MessageRendererState,
  ): import('../channels/types.js').StreamingCardSession | null {
    if (this.streamingSession) return this.streamingSession;
    this.streamingSession = this.adapter.createStreamingSession(
      this.inbound.chatId,
      undefined,
      this.inbound.replyToMessageId,
      this.getStreamingHeader(state),
    );
    return this.streamingSession;
  }

  private getStreamingHeader(state: MessageRendererState): { template: string; title: string } {
    if (state.isContinuation) {
      return { template: 'blue', title: `🔄 继续执行 (${state.totalTools} 步已完成)` };
    }
    return {
      template: 'blue',
      title: state.phase === 'starting' ? '⏳ 准备开始' : '⏳ 执行中',
    };
  }

  private async retireStreamingCard(): Promise<void> {
    if (!this.streamingSession) {
      return;
    }
    const session = this.streamingSession;
    this.streamingSession = null;
    this.streamingRetired = true;
    await session.close().catch(() => {});
  }
}
