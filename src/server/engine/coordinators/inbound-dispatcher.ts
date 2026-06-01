import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import { generateRequestId, type LogContext } from '../../../shared/logger.js';
import type { CommandRouter } from '../command-router.js';
import { publicTextCommandName } from '../commands/slash-policy.js';
import { conversationSurface } from '../conversations/surface-policy.js';
import { handleCallbackMessage } from '../messages/callback-dispatcher.js';
import type { TextDispatcher } from '../messages/text-dispatcher.js';
import type { SDKEngine } from '../sdk/engine.js';
import type { SessionStateManager } from '../state/session-state.js';
import type { IngressCoordinator } from './ingress.js';
import type { PermissionCoordinator } from './permission.js';
import type { QueryOrchestrator } from './query.js';

export interface InboundDispatcherOptions {
  state: SessionStateManager;
  ingress: IngressCoordinator;
  text: TextDispatcher;
  permissions: PermissionCoordinator;
  sdkEngine: SDKEngine;
  commands: CommandRouter;
  query: QueryOrchestrator;
}

const TOPIC_TLIVE_COMMANDS = new Set([
  '/stop',
  '/tlive',
  '/home',
  '/home-refresh',
  '/home-view',
  '/home-dir',
  '/client-upgrade',
  '/continue',
]);

/**
 * Routes one normalized inbound message into text, callback, command, or query handling.
 *
 * BridgeManager owns adapter lifecycle and queue loops; this dispatcher owns per-message
 * routing decisions.
 */
export class InboundDispatcher {
  constructor(private readonly options: InboundDispatcherOptions) {}

  async handle(
    adapter: BaseChannelAdapter,
    msg: InboundMessage,
    requestId?: string,
  ): Promise<boolean> {
    const ctx: LogContext = { requestId: requestId || generateRequestId(), chatId: msg.chatId };
    const { state, ingress, text, permissions, sdkEngine, commands, query } = this.options;

    if (msg.callbackData && !msg.chatId) {
      console.warn(`[${adapter.channelType}] ${ctx.requestId} CALLBACK dropped: missing chat id`);
      return false;
    }

    if (!msg.chatId && msg.userId) {
      const userLastChat = state.getUserLastChat(msg.userId);
      if (userLastChat && userLastChat.channelType === adapter.channelType) {
        console.log(
          `[${adapter.channelType}] ${ctx.requestId} MENU fallback to user's last chat ${userLastChat.chatId.slice(-8)}`,
        );
        msg = { ...msg, chatId: userLastChat.chatId };
        ctx.chatId = msg.chatId;
      } else {
        console.warn(
          `[${adapter.channelType}] ${ctx.requestId} MENU dropped: no recent chat for user ${msg.userId}`,
        );
        return false;
      }
    }

    if (!adapter.isAuthorized(msg.userId, msg.chatId)) {
      return false;
    }

    if (msg.chatId && msg.userId) {
      state.setUserLastChat(msg.userId, adapter.channelType, msg.chatId);
    }

    if (msg.chatId) {
      ingress.recordDeliveryTarget(msg);
    }

    const attachmentResult = ingress.prepareAttachments(msg);
    msg = attachmentResult.message;
    if (attachmentResult.handled) {
      return true;
    }

    const surface = conversationSurface({ threadId: msg.threadId, scopeId: msg.scopeId });
    const publicCommand = msg.callbackData ? null : publicTextCommandName(msg.text);
    if (publicCommand && shouldHandlePublicCommandBeforeAgent(publicCommand, surface)) {
      const handled = await commands.handle(adapter, msg);
      if (handled) {
        console.log(`[bridge] ${ctx.requestId} CMD ${publicCommand}`);
        return true;
      }
    }

    if (await text.handle(adapter, msg)) {
      return true;
    }

    if (msg.callbackData) {
      return handleCallbackMessage(adapter, msg, {
        permissions,
        sdkEngine,
        runAction: (actionAdapter, actionMsg, action) =>
          commands.handleAction(actionAdapter, actionMsg, action),
        replayMessage: (replayAdapter, replayMsg) =>
          this.handle(replayAdapter, replayMsg, ctx.requestId),
      });
    }

    if (!publicCommand && msg.text.startsWith('/')) {
      const handled = await commands.handle(adapter, msg);
      if (handled) {
        console.log(`[bridge] ${ctx.requestId} CMD ${msg.text.split(' ')[0]}`);
        return true;
      }
    }

    if (surface === 'workbench') {
      await adapter
        .send(
          {
            chatId: msg.chatId,
            text: '⚠️ 主窗口只处理 TLive 命令。请用 /home 打开工作台并点击新建会话，或使用 /new claude 创建话题。',
          },
        )
        .catch(() => {});
      return true;
    }

    return query.run(adapter, msg, ctx.requestId);
  }
}

function shouldHandlePublicCommandBeforeAgent(
  command: string,
  surface: ReturnType<typeof conversationSurface>,
): boolean {
  if (surface !== 'topic') return true;
  return TOPIC_TLIVE_COMMANDS.has(command);
}
