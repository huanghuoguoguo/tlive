import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import { CostTracker } from '../cost-tracker.js';
import type { ConversationEngine } from '../../utils/conversation.js';
import type { ChannelRouter } from '../../utils/router.js';
import type { SessionStateManager } from '../state/session-state.js';
import type { PermissionCoordinator } from './permission.js';
import type { SDKEngine } from '../sdk/engine.js';
import { shortPath } from '../../core/path.js';
import type { BridgeStore, ChannelBinding } from '../../store/interface.js';
import type { AgentSettingSource } from '../../config.js';
import type { TopicSessionManager } from '../state/topic-sessions.js';
import { Logger, type LogContext } from '../../logger.js';
import type { AgentProvider } from '../../providers/base.js';
import { singleProviderRegistry, type AgentProviderRegistry } from '../../providers/registry.js';
import { QueryContext } from './query-context.js';
import { withInboundReplyContext } from '../../channels/reply-context.js';
import {
  TopicConversationService,
  type TopicSessionBindingSnapshot,
} from '../conversations/topic-conversation.js';
import { deliveryRouteFromInbound } from '../../channels/delivery-route.js';
import { QueryTurnRunner } from './query-turn-runner.js';
import { conversationScopeId } from '../../channels/conversation-context.js';
import { QueryPresentationFactory } from './query-presentation.js';
import { QuerySdkInteractionsFactory } from './query-sdk-interactions.js';
import { QueryRecoveryPolicy } from './query-recovery.js';

interface QueryOrchestratorOptions {
  engine: ConversationEngine;
  llm: AgentProvider;
  providers?: AgentProviderRegistry;
  router: ChannelRouter;
  state: SessionStateManager;
  permissions: PermissionCoordinator;
  sdkEngine: SDKEngine;
  store: BridgeStore;
  defaultWorkdir: string;
  topicSessions?: TopicSessionManager;
  defaultAgentSettingSources: AgentSettingSource[];
  port: number;
  appendSystemPrompt?: string;
  onConversationMessageResolved?: (msg: InboundMessage, rawMsg: InboundMessage) => void | Promise<void>;
}

/**
 * Executes the full provider query lifecycle for one inbound message:
 * binding/session rotation, renderer + typing lifecycle, SDK permission callbacks,
 * and final reaction/cleanup handling.
 */
export class QueryOrchestrator {
  private conversations: TopicConversationService;
  private turnRunner: QueryTurnRunner;
  private presentation: QueryPresentationFactory;
  private sdkInteractions: QuerySdkInteractionsFactory;
  private recovery: QueryRecoveryPolicy;

  constructor(private options: QueryOrchestratorOptions) {
    const providers = options.providers ?? singleProviderRegistry(options.llm);
    this.conversations = new TopicConversationService({
      store: options.store,
      router: options.router,
      sdkEngine: options.sdkEngine,
      topicSessions: options.topicSessions,
      defaultWorkdir: options.defaultWorkdir,
    });
    this.turnRunner = new QueryTurnRunner({
      engine: options.engine,
      providers,
      state: options.state,
      sdkEngine: options.sdkEngine,
      store: options.store,
      defaultWorkdir: options.defaultWorkdir,
      defaultAgentSettingSources: options.defaultAgentSettingSources,
      appendSystemPrompt: options.appendSystemPrompt,
      onSdkSessionId: (query, id) => {
        this.recordTopicSession(query.msg, query.binding, { sdkSessionId: id });
      },
    });
    this.presentation = new QueryPresentationFactory({
      defaultWorkdir: options.defaultWorkdir,
    });
    this.sdkInteractions = new QuerySdkInteractionsFactory({
      permissions: options.permissions,
      state: options.state,
      router: options.router,
      interactionState: options.sdkEngine.getInteractionState(),
    });
    this.recovery = new QueryRecoveryPolicy({
      defaultWorkdir: options.defaultWorkdir,
      sdkEngine: options.sdkEngine,
      state: options.state,
      store: options.store,
    });
  }

  async run(
    adapter: BaseChannelAdapter,
    msg: InboundMessage,
    requestId?: string,
  ): Promise<boolean> {
    const rawMsg = msg;
    const resolved = await this.conversations.resolve(adapter, msg);
    msg = resolved.msg;
    const scopeId = resolved.route.logicalScopeId;
    await this.options.onConversationMessageResolved?.(msg, rawMsg);
    const ctx: LogContext = { requestId, chatId: scopeId };
    // Update last active time (no session reset - let SDK decide via SessionStaleError)
    this.options.state.checkAndUpdateLastActive(msg.channelType, scopeId);

    const binding = resolved.binding;
    if (!resolved.target) {
      await adapter
        .send(
          withInboundReplyContext(
            {
              chatId: msg.chatId,
              text: '⚠️ 引用的会话已失效，请直接发送消息或切换会话后重试',
            },
            msg,
          ),
        )
        .catch(() => {});
      return true;
    }

    let sessionTarget = resolved.target;
    let routeBinding: ChannelBinding =
      sessionTarget.source === 'current'
        ? binding
        : {
            ...binding,
            sessionId: sessionTarget.bindingSessionId,
            sdkSessionId: sessionTarget.sdkSessionId,
            cwd: sessionTarget.workdir,
            provider: sessionTarget.provider ?? binding.provider,
          };

    ctx.sessionId = routeBinding.sessionId;
    console.log(
      `[query] ${ctx.requestId} START session=${routeBinding.sessionId.slice(-4)} cwd=${shortPath(routeBinding.cwd || this.options.defaultWorkdir)} source=${sessionTarget.source}`,
    );

    const reactions = adapter.getLifecycleReactions();
    adapter.addReaction(msg.chatId, msg.messageId, reactions.processing).catch(() => {});

    const costTracker = new CostTracker();
    costTracker.start();

    // Retry logic for stale session
    let attemptCount = 0;
    let resumeFallbackMessage: string | undefined;
    const maxAttempts = 2; // Try once with resume, then once fresh

    while (attemptCount < maxAttempts) {
      attemptCount++;
      const currentBinding =
        attemptCount > 1 && sessionTarget.source === 'current'
          ? await this.options.router.resolve(msg.channelType, scopeId)
          : routeBinding;
      if (attemptCount > 1 && sessionTarget.source === 'current') {
        routeBinding = currentBinding;
      }

      const typing = this.presentation.startTyping(adapter, msg);
      const { renderer, presenter } = this.presentation.createTurn({
        adapter,
        msg,
        binding: currentBinding,
        sessionKey: sessionTarget.sessionKey,
        reactions,
        typing,
        onMessageId: (messageId) => {
          this.linkProgressMessage(msg, currentBinding, sessionTarget.sessionKey, messageId);
        },
      });
      const fileDeliveryRouteToken = this.options.appendSystemPrompt
        ? this.options.sdkEngine.registerFileDeliveryRoute(
            sessionTarget.sessionKey,
            deliveryRouteFromInbound(msg),
            currentBinding.cwd || this.options.defaultWorkdir,
          )
        : undefined;

      const sdkInteractions = this.sdkInteractions.create({
        adapter,
        msg,
        binding: currentBinding,
        renderer,
        reactions,
      });

      try {
        const queryCtx = new QueryContext(
          adapter,
          msg,
          currentBinding,
          sessionTarget.sessionKey,
          renderer,
          costTracker,
          sdkInteractions.permission,
          sdkInteractions.askQuestion,
          sdkInteractions.deferredTool,
          ctx,
        );
        const outcome = await this.turnRunner.run(queryCtx, fileDeliveryRouteToken);

        if (renderer.messageId) {
          this.linkProgressMessage(
            msg,
            currentBinding,
            sessionTarget.sessionKey,
            renderer.messageId,
          );
          console.log(`[query] ${ctx.requestId} SENT msgId=${renderer.messageId.slice(-8)}`);
        }

        // Show resume fallback message if we recovered from stale session
        if (resumeFallbackMessage && renderer.messageId) {
          // Send as a separate message after the turn completes
          adapter
            .send(withInboundReplyContext({ chatId: msg.chatId, text: resumeFallbackMessage }, msg))
            .catch(() => {});
        }

        const finalReaction = outcome === 'failed' ? reactions.error : reactions.done;
        adapter.addReaction(msg.chatId, msg.messageId, finalReaction).catch(() => {});
        if (renderer.messageId) {
          adapter.addReaction(msg.chatId, renderer.messageId, finalReaction).catch(() => {});
        }

        // Turn reached a terminal state; break out of retry loop.
        break;
      } catch (err) {
        if (this.recovery.canRetryStaleSession(err, attemptCount, maxAttempts)) {
          const recovered = await this.recovery.recoverStaleSession({
            adapter,
            msg,
            scopeId,
            currentBinding,
            sessionTarget,
            requestId: ctx.requestId,
            renderer,
            presenter,
          });
          routeBinding = recovered.routeBinding;
          sessionTarget = recovered.sessionTarget;
          resumeFallbackMessage = recovered.resumeFallbackMessage;
          continue;
        }

        console.error(`[query] ${ctx.requestId} FATAL ${Logger.formatError(err)}`);
        adapter.addReaction(msg.chatId, msg.messageId, reactions.error).catch(() => {});
        // Also add error reaction to the bot's progress message
        if (renderer.messageId) {
          adapter.addReaction(msg.chatId, renderer.messageId, reactions.error).catch(() => {});
        }
        throw err;
      } finally {
        typing.stop();
      }
    }

    return true;
  }

  private recordTopicSession(
    msg: InboundMessage,
    binding: TopicSessionBindingSnapshot,
    updates: { sdkSessionId?: string; lastMessageId?: string } = {},
  ): void {
    this.conversations.recordTopicSession(msg, binding, updates);
  }

  private linkProgressMessage(
    msg: InboundMessage,
    binding: TopicSessionBindingSnapshot,
    sessionKey: string,
    messageId: string,
  ): void {
    this.options.sdkEngine.setActiveMessageId(
      this.options.state.stateKey(msg.channelType, conversationScopeId(msg)),
      messageId,
      sessionKey,
    );
    this.recordTopicSession(msg, binding, {
      sdkSessionId: binding.sdkSessionId,
      lastMessageId: messageId,
    });
  }
}
