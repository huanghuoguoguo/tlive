import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';
import type { PermissionCoordinator } from './permission-coordinator.js';
import type { SessionStateManager } from './session-state.js';
import type { SDKEngine } from './sdk-engine.js';

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
  coalesceMessage: (adapter: BaseChannelAdapter, msg: InboundMessage) => Promise<InboundMessage>;
  handleMessage: (adapter: BaseChannelAdapter, msg: InboundMessage) => Promise<unknown>;
  onError: (err: unknown) => void;
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
    handleMessage(adapter, coalesced)
      .then(() => this.drainQueue(adapter, coalesced.channelType, coalesced.chatId, handleMessage, onError))
      .catch(onError)
      .finally(() => this.options.state.setProcessing(chatKey, false));
  }

  private async handleBusyChat(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<void> {
    if (msg.text && this.options.sdkEngine.canSteer(msg.channelType, msg.chatId, msg.replyToMessageId)) {
      this.options.sdkEngine.steer(msg.channelType, msg.chatId, msg.text);
      await adapter.send({ chatId: msg.chatId, text: '💬 Message sent to active session' }).catch(() => {});
      return;
    }

    if (!msg.text) {
      return;
    }

    const queued = this.options.sdkEngine.queueMessage(msg.channelType, msg.chatId, msg);
    if (queued) {
      await adapter.send({ chatId: msg.chatId, text: '📥 Queued — will process after current task' }).catch(() => {});
    } else {
      await adapter.send({ chatId: msg.chatId, text: '⚠️ Queue full — please wait for current tasks to finish' }).catch(() => {});
    }
  }

  private async drainQueue(
    adapter: BaseChannelAdapter,
    channelType: string,
    chatId: string,
    handleMessage: (adapter: BaseChannelAdapter, msg: InboundMessage) => Promise<unknown>,
    onError: (err: unknown) => void,
  ): Promise<void> {
    let next = this.options.sdkEngine.dequeueMessage(channelType, chatId);
    while (next) {
      console.log(`[${adapter.channelType}] Processing queued message`);
      try {
        await handleMessage(adapter, next);
      } catch (err) {
        onError(err);
        break;
      }
      next = this.options.sdkEngine.dequeueMessage(channelType, chatId);
    }
  }
}
