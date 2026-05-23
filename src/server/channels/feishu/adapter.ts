import { Client, WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import { BaseChannelAdapter } from '../base.js';
import type { InboundMessage, SendResult, ThreadStartResult } from '../types.js';
import type { BridgeError } from '../errors.js';
import { RateLimitError, AuthError } from '../errors.js';
import { FeishuStreamingSession } from './streaming.js';
import { FeishuFormatter } from './formatter.js';
import { FEISHU_POLICY } from './policy.js';
import type { FeishuRenderedMessage } from './types.js';
import type { QuickButtonName } from '../../../shared/ui/buttons.js';
import { feishuMessageEventToInbound, type FeishuMessageReceiveEvent } from './inbound.js';
import { feishuCardActionToInbound, feishuMenuEventToInbound } from './events.js';
import {
  editFeishuMessage,
  pinFeishuMessage,
  sendFeishuMessage,
  shouldSplitFeishuProgressMessage,
  startFeishuThreadFromMessage,
  startFeishuThreadWithTitle,
} from './sender.js';
import { t } from '../../../shared/i18n/index.js';

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
  allowedUsers: string[];
}

export interface FeishuAdapterOptions {
  doneButtons?: readonly QuickButtonName[];
  autoPinTopics?: boolean;
}

export class FeishuAdapter extends BaseChannelAdapter<FeishuRenderedMessage> {
  readonly channelType = 'feishu' as const;
  protected readonly policy = FEISHU_POLICY;
  private client: Client | null = null;
  private wsClient: WSClient | null = null;
  private config: FeishuConfig;
  private messageQueue: InboundMessage[] = [];
  private autoPinTopics: boolean;

  constructor(config: FeishuConfig, options: FeishuAdapterOptions = {}) {
    super();
    this.config = config;
    this.autoPinTopics = options.autoPinTopics ?? false;
    // Set platform-specific formatter and policy (Chinese locale for Feishu)
    this.formatter = new FeishuFormatter('zh', { doneButtons: options.doneButtons });
  }

  async start(): Promise<void> {
    this.client = new Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });

    const eventDispatcher = new EventDispatcher({
      verificationToken: this.config.verificationToken,
      encryptKey: this.config.encryptKey,
    });

    eventDispatcher.register({
      'im.message.receive_v1': async (event: FeishuMessageReceiveEvent) => {
        if (!this.client) return;
        const inbound = await feishuMessageEventToInbound(event, this.client);
        if (inbound) this.messageQueue.push(inbound);
      },
    });

    // Register card action handler for button callbacks and form submissions (schema 2.0 cards)
    eventDispatcher.register({
      'card.action.trigger': async (data: unknown) => {
        console.log('[feishu] card.action.trigger received:', JSON.stringify(data).slice(0, 500));
        const result = feishuCardActionToInbound(data);
        if (result.missingAction) {
          console.warn('[feishu] card.action.trigger: no action value found');
        }
        if (result.message) this.messageQueue.push(result.message);
        return result.response;
      },
    } as any);

    eventDispatcher.register({
      'application.bot.menu_v6': async (data: unknown) => {
        const inbound = feishuMenuEventToInbound(data);
        if (!inbound) {
          console.warn(
            '[feishu] application.bot.menu_v6: unknown event key',
            (data as { event_key?: string })?.event_key,
          );
          return {};
        }
        this.messageQueue.push(inbound);
        return {};
      },
    } as any);

    // Use WebSocket long connection (no public callback URL needed)
    this.wsClient = new WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });

    await this.wsClient.start({ eventDispatcher });
  }

  async stop(): Promise<void> {
    if (this.wsClient) {
      try {
        (this.wsClient as any).close?.();
      } catch {
        /* best effort */
      }
      this.wsClient = null;
    }
    this.client = null;
  }

  async consumeOne(): Promise<InboundMessage | null> {
    return this.messageQueue.shift() ?? null;
  }

  override async startThreadFromMessage(
    chatId: string,
    messageId: string,
    text?: string,
  ): Promise<ThreadStartResult | null> {
    const finalText = text ?? t('feishu.topicProcessing');
    return startFeishuThreadFromMessage(this.client, {
      chatId,
      messageId,
      text: finalText,
      autoPinTopics: this.autoPinTopics,
      classifyError: (err) => this.classifyError(err),
    });
  }

  override async startThreadWithTitle(
    chatId: string,
    title: string,
    text?: string,
  ): Promise<ThreadStartResult | null> {
    const finalText = text ?? t('feishu.topicContinue');
    return startFeishuThreadWithTitle(this.client, {
      chatId,
      title,
      text: finalText,
      autoPinTopics: this.autoPinTopics,
      classifyError: (err) => this.classifyError(err),
    });
  }

  async send(message: FeishuRenderedMessage): Promise<SendResult> {
    if (!this.client) throw new Error('Feishu client not started');
    return sendFeishuMessage(this.client, message, (err) => this.classifyError(err));
  }

  async pinMessage(messageId: string): Promise<void> {
    await pinFeishuMessage(this.client, messageId);
  }

  async deleteMessage(_chatId: string, messageId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.im.message.delete({ path: { message_id: messageId } });
    } catch {
      // Non-fatal
    }
  }

  async editMessage(
    _chatId: string,
    messageId: string,
    message: FeishuRenderedMessage,
  ): Promise<void> {
    await editFeishuMessage(this.client, messageId, message, (err) => this.classifyError(err));
  }

  createStreamingSession(
    chatId: string,
    receiveIdType?: string,
    replyToMessageId?: string,
    header?: { template: string; title: string },
    replyInThread?: boolean,
  ): FeishuStreamingSession | null {
    if (!this.client) return null;
    return new FeishuStreamingSession({
      client: this.client,
      chatId,
      receiveIdType,
      replyToMessageId,
      header,
      replyInThread,
    });
  }

  override shouldSplitProgressMessage(message: FeishuRenderedMessage): boolean {
    return shouldSplitFeishuProgressMessage(message);
  }

  async sendTyping(_chatId: string): Promise<void> {
    // Feishu has no native typing API; reactions are used instead
    // (handled by bridge-manager via addReaction)
  }

  private reactionIds = new Map<string, string>();

  async addReaction(_chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client) return;
    try {
      // Remove existing reaction first (if any)
      await this.removeReaction(_chatId, messageId);
      const result = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      });
      const reactionId = (result as any)?.data?.reaction_id;
      if (reactionId) this.reactionIds.set(messageId, reactionId);
    } catch {
      /* non-fatal */
    }
  }

  async removeReaction(_chatId: string, messageId: string): Promise<void> {
    if (!this.client) return;
    const reactionId = this.reactionIds.get(messageId);
    if (!reactionId) return;
    try {
      await this.client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
      this.reactionIds.delete(messageId);
    } catch {
      // Non-fatal
    }
  }

  validateConfig(): string | null {
    if (!this.config.appId) return 'TL_FS_APP_ID is required for Feishu';
    if (!this.config.appSecret) return 'TL_FS_APP_SECRET is required for Feishu';
    return null;
  }

  isAuthorized(userId: string, _chatId: string): boolean {
    if (this.config.allowedUsers.length === 0) return true;
    // userId may be user_id or open_id — match against either format in allowedUsers
    return this.config.allowedUsers.includes(userId);
  }

  // --- Error classification (OCP: platform-specific error handling) ---

  /** Classify Feishu/Lark SDK errors */
  classifyError(err: unknown): BridgeError {
    const e = err as Record<string, any>;
    const message = e?.message ?? String(err);

    // Feishu uses numeric error codes
    const code = e?.code;
    const statusCode = e?.statusCode ?? e?.status ?? e?.response?.statusCode ?? e?.response?.status;
    if (code === 230020 || code === 99991400 || statusCode === 429) {
      return new RateLimitError(message, readRetryAfterMs(e));
    }
    if (code === 99991401 || code === 99991403) return new AuthError(message);

    return super.classifyError(err);
  }

  /** Get Feishu bot info for display */
  getBotInfo(): { appId?: string; name?: string } {
    return { appId: this.config.appId };
  }
}

function readRetryAfterMs(err: Record<string, any>): number {
  const headers = err?.response?.headers ?? err?.headers ?? {};
  const retryAfter = headers['retry-after'] ?? headers['Retry-After'];
  const seconds = Number(retryAfter);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 2000;
}
