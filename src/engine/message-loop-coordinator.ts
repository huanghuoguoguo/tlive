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
    if (msg.text) {
      // Use SDK native queue: if there's an active session, send with priority
      if (this.options.sdkEngine.hasActiveSession(msg.channelType, msg.chatId)) {
        // Steer if turn is active (inject into running turn)
        const sessionKey = this.options.state.stateKey(msg.channelType, msg.chatId);
        const canSteerResult = this.options.sdkEngine.canSteer(msg.channelType, msg.chatId, msg.replyToMessageId);

        if (canSteerResult) {
          // Legacy steer via reply-to-message matching
          const sent = await this.options.sdkEngine.steer(msg.channelType, msg.chatId, msg.text);
          if (sent) {
            await adapter.send({ chatId: msg.chatId, text: '💬 Message injected into active session' }).catch(() => {});
            return;
          }
        }

        // Queue for later using SDK native priority='later'
        const queued = await this.options.sdkEngine.queue(msg.channelType, msg.chatId, msg.text);
        if (queued) {
          await adapter.send({ chatId: msg.chatId, text: '📥 Queued — will process after current task' }).catch(() => {});
          return;
        }
      }

      // No active session or SDK queue failed — drop message
      await adapter.send({ chatId: msg.chatId, text: '⚠️ No active session — please start a task first' }).catch(() => {});
    }
  }

  private async drainQueue(
    adapter: BaseChannelAdapter,
    channelType: string,
    chatId: string,
    handleMessage: (adapter: BaseChannelAdapter, msg: InboundMessage) => Promise<unknown>,
    onError: (err: unknown) => void,
  ): Promise<void> {
    // SDK handles queue internally — no manual drain needed
    // This method is kept for backwards compatibility but does nothing
  }
}
