import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import type { ChannelBinding, BridgeStore } from '../../store/interface.js';
import type { ChannelRouter } from '../../utils/router.js';
import type { SDKEngine, ResolvedSessionTarget } from '../sdk/engine.js';
import type { TopicSessionManager } from '../state/topic-sessions.js';
import { chatScopeId, sessionKey as buildSessionKey } from '../../core/key.js';
import {
  conversationRouteFromInbound,
  conversationScopeId,
  type ConversationRoute,
} from '../../channels/conversation-context.js';
import { generateSessionId } from '../../core/id.js';
import { truncate } from '../../core/string.js';
import { Logger } from '../../logger.js';

type SessionTargetFailureReason =
  | 'no_session'
  | 'reply_target_missing'
  | 'send_failed'
  | 'busy_unsupported';

export interface TopicConversationServiceOptions {
  store: BridgeStore;
  router: ChannelRouter;
  sdkEngine: SDKEngine;
  topicSessions?: TopicSessionManager;
  defaultWorkdir: string;
}

export interface ResolvedConversation {
  msg: InboundMessage;
  route: ConversationRoute;
  scopeId: string;
  binding: ChannelBinding;
  target?: ResolvedSessionTarget;
  failureReason?: SessionTargetFailureReason;
}

export interface TopicSessionBindingSnapshot {
  channelType?: string;
  chatId?: string;
  cwd?: string;
  sdkSessionId?: string;
  provider?: ChannelBinding['provider'];
  clientId?: string;
}

interface ClaimedThreadSession {
  binding: ChannelBinding;
  target: ResolvedSessionTarget;
}

/**
 * Owns the product-level conversation model:
 * - the main Feishu chat is a workbench/control surface
 * - each Feishu topic is one logical agent conversation scope
 * - provider SDK sessions are indexed back to their topic for /home and /continue
 */
export class TopicConversationService {
  constructor(private options: TopicConversationServiceOptions) {}

  async resolve(
    adapter: BaseChannelAdapter,
    rawMsg: InboundMessage,
  ): Promise<ResolvedConversation> {
    const msg = await this.ensureTopicScope(adapter, rawMsg);
    const route = conversationRouteFromInbound(msg);
    const scopeId = route.logicalScopeId;
    const existingBinding = await this.options.store.getBinding(msg.channelType, scopeId);
    let binding = existingBinding ?? (await this.options.router.resolve(msg.channelType, scopeId));

    const claimed = await this.claimThreadSession(msg, scopeId, binding, !existingBinding);
    if (claimed) {
      binding = claimed.binding;
      return { msg, route, scopeId, binding, target: claimed.target };
    }

    const sessionReplyMessageId = msg.threadId ? undefined : msg.replyToMessageId;
    const targetResult = this.options.sdkEngine.resolveSessionTarget?.(
      msg.channelType,
      scopeId,
      binding,
      this.options.defaultWorkdir,
      sessionReplyMessageId,
    ) ?? {
      target: {
        sessionKey: buildSessionKey(msg.channelType, scopeId, binding.sessionId),
        bindingSessionId: binding.sessionId,
        workdir: binding.cwd || this.options.defaultWorkdir,
        sdkSessionId: binding.sdkSessionId,
        provider: binding.provider,
        source: 'current' as const,
      },
    };

    return {
      msg,
      route,
      scopeId,
      binding,
      target: targetResult.target,
      failureReason: targetResult.failureReason,
    };
  }

  recordTopicSession(
    msg: InboundMessage,
    binding: TopicSessionBindingSnapshot,
    updates: { sdkSessionId?: string; lastMessageId?: string } = {},
  ): void {
    if (!msg.threadId || !this.options.topicSessions) return;
    const scopeId = conversationScopeId(msg);
    const preview = truncate((msg.text || '').trim() || 'Agent 会话', 120);
    this.options.topicSessions.upsert({
      channelType: msg.channelType,
      chatId: msg.chatId,
      scopeId,
      threadId: msg.threadId,
      rootMessageId: msg.threadRootMessageId ?? msg.replyTargetMessageId,
      lastMessageId: updates.lastMessageId ?? msg.replyTargetMessageId ?? msg.messageId,
      sdkSessionId: updates.sdkSessionId ?? binding.sdkSessionId,
      provider: binding.provider,
      clientId: binding.clientId,
      cwd: binding.cwd || this.options.defaultWorkdir,
      title: preview,
      preview,
    });
  }

  private async ensureTopicScope(
    adapter: BaseChannelAdapter,
    msg: InboundMessage,
  ): Promise<InboundMessage> {
    if (
      msg.threadId ||
      msg.callbackData ||
      !msg.messageId ||
      typeof adapter.startThreadFromMessage !== 'function'
    ) {
      return msg;
    }

    const started = await adapter
      .startThreadFromMessage(msg.chatId, msg.messageId, '💬 已开启话题，正在处理...')
      .catch((err) => {
        console.warn(`[query] start thread failed: ${Logger.formatError(err)}`);
        return null;
      });
    if (!started) return msg;

    const threadId = started.threadId;
    const scopeId = chatScopeId(msg.chatId, threadId);
    console.log(`[query] AUTO_THREAD chat=${msg.chatId.slice(-8)} thread=${threadId.slice(-8)}`);
    return {
      ...msg,
      scopeId,
      threadId,
      replyInThread: true,
      replyTargetMessageId: started.messageId,
      threadRootMessageId: started.rootMessageId ?? started.messageId,
      threadParentMessageId: started.messageId,
    };
  }

  private async claimThreadSession(
    msg: InboundMessage,
    scopeId: string,
    binding: ChannelBinding,
    allowClaim: boolean,
  ): Promise<ClaimedThreadSession | null> {
    if (!allowClaim || !msg.threadId) return null;

    const candidates = [
      msg.replyToMessageId,
      msg.threadParentMessageId,
      msg.threadRootMessageId,
    ].filter((id): id is string => !!id);

    for (const messageId of candidates) {
      const sessionKey = this.options.sdkEngine.getSessionForBubble?.(messageId);
      const managed = sessionKey
        ? this.options.sdkEngine.getSessionContext?.(sessionKey)
        : undefined;
      if (!sessionKey || !managed) continue;

      const oldBinding = await this.options.store.getBinding(managed.channelType, managed.chatId);
      const movedKey =
        managed.chatId === scopeId
          ? sessionKey
          : this.options.sdkEngine.moveSessionToChat(sessionKey, scopeId);
      if (!movedKey) continue;

      const moved = this.options.sdkEngine.getSessionContext(movedKey);
      if (!moved) continue;

      const topicBinding: ChannelBinding = {
        channelType: msg.channelType,
        chatId: scopeId,
        sessionId: moved.bindingSessionId,
        sdkSessionId: moved.sdkSessionId,
        provider: moved.provider ?? oldBinding?.provider ?? binding.provider,
        clientId: oldBinding?.clientId ?? binding.clientId,
        cwd: moved.workdir,
        agentSettingSources: oldBinding?.agentSettingSources ?? binding.agentSettingSources,
        projectName: oldBinding?.projectName ?? binding.projectName,
        createdAt: binding.createdAt,
      };
      await this.options.store.saveBinding(topicBinding);
      this.recordTopicSession(msg, topicBinding, {
        sdkSessionId: moved.sdkSessionId,
        lastMessageId: candidates[0],
      });

      if (
        oldBinding &&
        oldBinding.chatId !== scopeId &&
        oldBinding.sessionId === moved.bindingSessionId
      ) {
        oldBinding.sessionId = generateSessionId();
        oldBinding.sdkSessionId = undefined;
        await this.options.store.saveBinding(oldBinding);
      }

      console.log(`[query] CLAIM_THREAD session=${movedKey} by message=${messageId.slice(-8)}`);
      return {
        binding: topicBinding,
        target: {
          sessionKey: movedKey,
          bindingSessionId: moved.bindingSessionId,
          workdir: moved.workdir,
          sdkSessionId: moved.sdkSessionId,
          provider: moved.provider ?? oldBinding?.provider ?? binding.provider,
          source: 'current',
        },
      };
    }

    return null;
  }
}
