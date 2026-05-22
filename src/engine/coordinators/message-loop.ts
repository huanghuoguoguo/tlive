import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import type { PermissionCoordinator } from './permission.js';
import type { SessionStateManager } from '../state/session-state.js';
import type { SDKEngine, SendWithContextResult } from '../sdk/engine.js';
import { conversationScopeId } from '../../channels/conversation-context.js';
import { withInboundReplyContext } from '../../channels/reply-context.js';

interface MessageLoopCoordinatorOptions {
  state: SessionStateManager;
  sdkEngine: SDKEngine;
  permissions: PermissionCoordinator;
  quickCommands: Set<string>;
  hasPendingSdkQuestion: (msg: InboundMessage) => boolean;
  resolveProcessingKey: (msg: InboundMessage) => Promise<string>;
}

interface SlowMessageDispatchOptions {
  adapter: BaseChannelAdapter;
  msg: InboundMessage;
  requestId?: string;
  coalesceMessage: (adapter: BaseChannelAdapter, msg: InboundMessage) => Promise<InboundMessage>;
  handleMessage: (
    adapter: BaseChannelAdapter,
    msg: InboundMessage,
    requestId?: string,
  ) => Promise<unknown>;
  onError: (err: unknown, requestId: string | undefined, msg: InboundMessage) => void;
}

/**
 * Coordinates the adapter loop behavior for active chats:
 * - classifies fast-path messages that should be awaited inline
 * - serializes long-running chat turns with processing guards
 * - steers or queues follow-up messages while a turn is active
 */
export class MessageLoopCoordinator {
  private processingAliases = new Map<string, Set<string>>();

  constructor(private options: MessageLoopCoordinatorOptions) {}

  aliasProcessingKey(primaryKey: string, aliasKey: string): void {
    if (primaryKey === aliasKey || !this.options.state.isProcessing(primaryKey)) return;
    this.options.state.setProcessing(aliasKey, true);
    const aliases = this.processingAliases.get(primaryKey) ?? new Set<string>();
    aliases.add(aliasKey);
    this.processingAliases.set(primaryKey, aliases);
  }

  isQuickMessage(_adapter: BaseChannelAdapter, msg: InboundMessage): boolean {
    const hasPendingQuestion = this.options.hasPendingSdkQuestion(msg);

    return (
      !!msg.callbackData ||
      (msg.text && this.options.quickCommands.has(msg.text.split(' ')[0].toLowerCase())) ||
      this.options.permissions.parsePermissionText(msg.text || '') !== null ||
      hasPendingQuestion
    );
  }

  async dispatchSlowMessage({
    adapter,
    msg,
    requestId,
    coalesceMessage,
    handleMessage,
    onError,
  }: SlowMessageDispatchOptions): Promise<void> {
    let coalesced = msg;
    try {
      coalesced = await coalesceMessage(adapter, msg);
      const processingKey = await this.options.resolveProcessingKey(coalesced);

      if (this.options.state.isProcessing(processingKey)) {
        await this.handleBusyChat(adapter, coalesced);
        return;
      }

      this.options.state.setProcessing(processingKey, true);
      handleMessage(adapter, coalesced, requestId)
        .catch((err) => onError(err, requestId, coalesced))
        .finally(() => this.clearProcessing(processingKey));
    } catch (err) {
      onError(err, requestId, coalesced);
    }
  }

  private clearProcessing(processingKey: string): void {
    this.options.state.setProcessing(processingKey, false);
    const aliases = this.processingAliases.get(processingKey);
    if (!aliases) return;
    this.processingAliases.delete(processingKey);
    for (const alias of aliases) {
      this.options.state.setProcessing(alias, false);
    }
  }

  private async handleBusyChat(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<void> {
    if (!msg.text) return;

    const result = await this.options.sdkEngine.sendWithContext(
      msg.channelType,
      conversationScopeId(msg),
      msg.text,
      msg.replyToMessageId,
    );

    const feedbackText = this.formatQueueFeedback(result);
    if (feedbackText) {
      await adapter
        .send(withInboundReplyContext({ chatId: msg.chatId, text: feedbackText }, msg))
        .catch(() => {});
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
        if (result.failureReason === 'reply_target_missing') {
          return '⚠️ 引用的会话已失效，请直接发送消息或切换会话后重试';
        }
        if (result.failureReason === 'send_failed') {
          return '⚠️ 会话注入失败，请稍后重试';
        }
        if (result.failureReason === 'busy_unsupported') {
          return '⚠️ 当前 provider 不支持执行中插入消息，请等待完成或使用 /stop';
        }
        return '⚠️ 无活跃会话，请先开始任务';
      }
      if (result.queueFull) {
        const maxDepth =
          result.maxQueueDepth ??
          (typeof this.options.sdkEngine.getMaxQueueDepth === 'function'
            ? this.options.sdkEngine.getMaxQueueDepth()
            : 3);
        const depth = result.queueDepth ?? maxDepth;
        return `⚠️ 排队已满（${depth}/${maxDepth}），请稍后再发`;
      }
      return '⚠️ 会话处理失败，请稍后重试';
    }

    if (result.mode === 'steer') {
      return '💬 已插入当前会话';
    }

    if (result.mode === 'queue' && result.queuePosition !== undefined) {
      const maxDepth =
        result.maxQueueDepth ??
        (typeof this.options.sdkEngine.getMaxQueueDepth === 'function'
          ? this.options.sdkEngine.getMaxQueueDepth()
          : 3);
      return `📥 已排队（位置 ${result.queuePosition}/${maxDepth}），当前任务结束后继续处理`;
    }

    return null;
  }
}
