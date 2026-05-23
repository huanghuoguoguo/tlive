import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import { withInboundReplyContext } from '../../channels/reply-context.js';
import { truncate } from '../../core/string.js';
import { t, type Locale } from '../../i18n/index.js';
import { generateRequestId, Logger } from '../../logger.js';
import type { IngressCoordinator } from './ingress.js';
import type { MessageLoopCoordinator } from './message-loop.js';

export interface AdapterLoopRunnerOptions {
  ingress: IngressCoordinator;
  loop: MessageLoopCoordinator;
  handleInboundMessage: (
    adapter: BaseChannelAdapter,
    msg: InboundMessage,
    requestId?: string,
  ) => Promise<boolean>;
  pollDelayMs?: number;
}

/**
 * Polls one channel adapter and routes each inbound message into the engine.
 *
 * BridgeManager owns process lifecycle and dependency wiring; this runner owns
 * the adapter loop behavior and user-visible loop error notification.
 */
export class AdapterLoopRunner {
  private readonly pollDelayMs: number;

  constructor(private readonly options: AdapterLoopRunnerOptions) {
    this.pollDelayMs = options.pollDelayMs ?? 100;
  }

  async run(adapter: BaseChannelAdapter, shouldContinue: () => boolean): Promise<void> {
    while (shouldContinue()) {
      let msg: InboundMessage | null = null;
      let requestId: string | undefined;

      try {
        msg = await this.options.ingress.getNextMessage(adapter);
        if (!msg) {
          await this.sleep();
          continue;
        }

        requestId = generateRequestId();
        this.logReceived(adapter, msg, requestId);

        if (this.options.loop.isQuickMessage(adapter, msg)) {
          await this.options.handleInboundMessage(adapter, msg, requestId);
          continue;
        }

        await this.options.loop.dispatchSlowMessage({
          adapter,
          msg,
          requestId,
          coalesceMessage: (dispatchAdapter, dispatchMsg) =>
            this.options.ingress.coalesceMessages(dispatchAdapter, dispatchMsg),
          handleMessage: (dispatchAdapter, dispatchMsg, rid) =>
            this.options.handleInboundMessage(dispatchAdapter, dispatchMsg, rid),
          onError: (err, rid, errorMsg) => {
            console.error(`[${adapter.channelType}] ${rid} ERROR: ${Logger.formatError(err)}`);
            this.sendErrorNotification(adapter, errorMsg.chatId, err, rid, errorMsg);
          },
        });
      } catch (err) {
        const rid = requestId ?? generateRequestId();
        console.error(`[${adapter.channelType}] ${rid} LOOP_ERROR: ${Logger.formatError(err)}`);
        this.sendErrorNotification(adapter, msg?.chatId, err, rid, msg ?? undefined);
      }
    }
  }

  sendErrorNotification(
    adapter: BaseChannelAdapter,
    chatId: string | undefined,
    err: unknown,
    requestId?: string,
    sourceMsg?: InboundMessage,
  ): void {
    if (!chatId) return;

    const _locale = this.resolveLocale(adapter);
    const errorMsg = err instanceof Error ? err.message : String(err);
    const notification = {
      chatId,
      text: `${t('error.title')}\n${t('error.requestId')}: ${requestId ?? 'unknown'}\n${truncate(errorMsg, 200)}`,
    };

    adapter
      .send(sourceMsg ? withInboundReplyContext(notification, sourceMsg) : notification)
      .catch(() => {});
  }

  private logReceived(adapter: BaseChannelAdapter, msg: InboundMessage, requestId: string): void {
    const textPreview = msg.text ? truncate(msg.text, 50) : '(callback)';
    const chatPreview = msg.chatId ? msg.chatId.slice(-8) : 'no-chat';
    console.log(
      `[${adapter.channelType}] ${requestId} RECV user=${msg.userId} chat=${chatPreview}: ${textPreview}`,
    );
  }

  private resolveLocale(adapter: BaseChannelAdapter): Locale {
    return typeof adapter.getLocale === 'function' ? adapter.getLocale() : 'zh';
  }

  private sleep(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.pollDelayMs));
  }
}
