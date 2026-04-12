import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';
import type { PermissionCoordinator } from './permission-coordinator.js';
import type { SessionStateManager } from './session-state.js';
import type { SDKEngine, SendWithContextResult } from './sdk-engine.js';

interface MessageLoopCoordinatorOptions {
  state: SessionStateManager;
  sdkEngine: SDKEngine;
  permissions: PermissionCoordinator;
  quickCommands: Set<string>;
  hasPendingSdkQuestion: (channelType: string, chatId: string) => boolean;
}

interface SlowMessageDispatchOptions {
  adapter: BaseChannelAdapter;
  msg: InboundMessage;
  requestId?: string;
  coalesceMessage: (adapter: BaseChannelAdapter, msg: InboundMessage) => Promise<InboundMessage>;
  handleMessage: (adapter: BaseChannelAdapter, msg: InboundMessage, requestId?: string) => Promise<unknown>;
  onError: (err: unknown, requestId?: string) => void;
}

/**
 * Coordinates the adapter loop behavior for active chats:
 * - classifies fast-path messages that should be awaited inline
 * - serializes long-running chat turns with processing guards
 * - steers or queues follow-up messages while a turn is active
 */
export class MessageLoopCoordinator {
  constructor(private options: MessageLoopCoordinatorOptions) {}

  isQuickMessage(adapter: BaseChannelAdapter, msg: InboundMessage): boolean {
    const hasPendingQuestion = this.options.permissions.getLatestPendingQuestion(adapter.channelType) !== null
      || this.options.hasPendingSdkQuestion(adapter.channelType, msg.chatId);

    return !!msg.callbackData
      || (msg.text && this.options.quickCommands.has(msg.text.split(' ')[0].toLowerCase()))
      || this.options.permissions.parsePermissionText(msg.text || '') !== null
      || hasPendingQuestion;
  }

  async dispatchSlowMessage({
    adapter,
    msg,
    requestId,
    coalesceMessage,
    handleMessage,
    onError,
  }: SlowMessageDispatchOptions): Promise<void> {
    const coalesced = await coalesceMessage(adapter, msg);
    const chatKey = this.options.state.stateKey(coalesced.channelType, coalesced.chatId);

    if (this.options.state.isProcessing(chatKey)) {
      await this.handleBusyChat(adapter, coalesced);
      return;
    }

    this.options.state.setProcessing(chatKey, true);
    handleMessage(adapter, coalesced, requestId)
      .catch((err) => onError(err, requestId))
      .finally(() => this.options.state.setProcessing(chatKey, false));
  }

  private async handleBusyChat(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<void> {
    if (!msg.text) return;

    const result = await this.options.sdkEngine.sendWithContext(
      msg.channelType,
      msg.chatId,
      msg.text,
      msg.replyToMessageId,
    );

    const feedbackText = this.formatQueueFeedback(result);
    if (feedbackText) {
      await adapter.send({ chatId: msg.chatId, text: feedbackText }).catch(() => {});
    }
  }

  /**
   * Format user feedback based on sendWithContext result.
   * - Steer: "已插入当前会话"
   * - Queue with position: "已排队（位置 X/Y）"
   * - Queue full: "排队已满，请稍后再发"
   * - No session: "无活跃会话，请先开始任务"
   */
  private formatQueueFeedback(result: SendWithContextResult): string | null {
    if (!result.sent) {
      if (result.mode === 'none') {
        return '⚠️ 无活跃会话，请先开始任务';
      }
      if (result.queueFull) {
        return '⚠️ 排队已满，请稍后再发';
      }
      // Send failed for other reason - no feedback needed
      return null;
    }

    if (result.mode === 'steer') {
      return '💬 已插入当前会话';
    }

    if (result.mode === 'queue' && result.queuePosition !== undefined) {
      const maxDepth = typeof this.options.sdkEngine.getMaxQueueDepth === 'function'
        ? this.options.sdkEngine.getMaxQueueDepth()
        : 3;
      return `📥 已排队（位置 ${result.queuePosition}/${maxDepth}），当前任务结束后继续处理`;
    }

    return null;
  }
}
