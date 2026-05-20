import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import { MessageRenderer } from '../messages/renderer.js';
import { CostTracker } from '../cost-tracker.js';
import type { ConversationEngine } from '../../utils/conversation.js';
import type { ChannelRouter } from '../../utils/router.js';
import type { SessionStateManager } from '../state/session-state.js';
import type { PermissionCoordinator } from './permission.js';
import type { SDKEngine } from '../sdk/engine.js';
import { PLATFORM_LIMITS } from '../../channels/limits.js';
import type { ChannelType } from '../../channels/types.js';
import { truncate } from '../../core/string.js';
import { shortPath } from '../../core/path.js';
import type { BridgeStore, ChannelBinding } from '../../store/interface.js';
import type { ClaudeSettingSource } from '../../config.js';
import type { TopicSessionManager } from '../state/topic-sessions.js';
import { Logger, type LogContext } from '../../logger.js';
import type { LiveSession } from '../../providers/base.js';
import type { ClaudeSDKProvider } from '../../providers/claude-sdk.js';
import { QueryExecutionPresenter } from '../messages/query-presenter.js';
import { SDKPermissionHandler } from '../sdk/permission-handler.js';
import { SDKAskQuestionHandler } from '../sdk/ask-question-handler.js';
import { SDKDeferredToolHandler } from '../sdk/deferred-tool-handler.js';
import { buildProgressData } from '../messages/progress-builder.js';
import type { MessageRendererState } from '../messages/renderer.js';
import { SessionStaleError, isStaleSessionError } from '../state/session-stale-error.js';
import { invalidateSessionCache } from '../../providers/session-scanner.js';
import { QueryContext } from './query-context.js';
import { t } from '../../i18n/index.js';
import { chatScopeId, messageScopeId } from '../../core/key.js';
import { withInboundReplyContext } from '../../channels/reply-context.js';
import { generateSessionId } from '../../core/id.js';

const DEBUG_EVENTS = process.env.TL_DEBUG_EVENTS === '1';

interface QueryOrchestratorOptions {
  engine: ConversationEngine;
  llm: ClaudeSDKProvider;
  router: ChannelRouter;
  state: SessionStateManager;
  permissions: PermissionCoordinator;
  sdkEngine: SDKEngine;
  store: BridgeStore;
  defaultWorkdir: string;
  topicSessions?: TopicSessionManager;
  defaultClaudeSettingSources: ClaudeSettingSource[];
  port: number;
  appendSystemPrompt?: string;
}

/**
 * Executes the full Claude query lifecycle for one inbound message:
 * binding/session rotation, renderer + typing lifecycle, SDK permission hooks,
 * and final reaction/cleanup handling.
 */
export class QueryOrchestrator {
  constructor(private options: QueryOrchestratorOptions) {}

  async run(adapter: BaseChannelAdapter, msg: InboundMessage, requestId?: string): Promise<boolean> {
    msg = await this.ensureThreadScope(adapter, msg);
    const scopeId = messageScopeId(msg);
    const ctx: LogContext = { requestId, chatId: scopeId };
    // Update last active time (no session reset - let SDK decide via SessionStaleError)
    this.options.state.checkAndUpdateLastActive(msg.channelType, scopeId);

    const existingBinding = await this.options.store.getBinding(msg.channelType, scopeId);
    let binding = existingBinding ?? await this.options.router.resolve(msg.channelType, scopeId);
    const claimed = await this.claimThreadSession(msg, scopeId, binding, !existingBinding);
    if (claimed) {
      binding = claimed.binding;
    }

    const sessionReplyMessageId = msg.threadId ? undefined : msg.replyToMessageId;
    const targetResult = claimed?.target ? { target: claimed.target } : this.options.sdkEngine.resolveSessionTarget?.(
      msg.channelType,
      scopeId,
      binding,
      this.options.defaultWorkdir,
      sessionReplyMessageId,
    ) ?? {
      target: {
        sessionKey: `${msg.channelType}:${scopeId}:${binding.sessionId}`,
        bindingSessionId: binding.sessionId,
        workdir: binding.cwd || this.options.defaultWorkdir,
        sdkSessionId: binding.sdkSessionId,
        source: 'current' as const,
      },
    };
    if (!targetResult.target) {
      await adapter.send(withInboundReplyContext({
        chatId: msg.chatId,
        text: '⚠️ 引用的会话已失效，请直接发送消息或切换会话后重试',
      }, msg)).catch(() => {});
      return true;
    }

    let sessionTarget = targetResult.target;
    let routeBinding: ChannelBinding = sessionTarget.source === 'current'
      ? binding
      : {
        ...binding,
        sessionId: sessionTarget.bindingSessionId,
        sdkSessionId: sessionTarget.sdkSessionId,
        cwd: sessionTarget.workdir,
      };

    ctx.sessionId = routeBinding.sessionId;
    console.log(
      `[query] ${ctx.requestId} START session=${routeBinding.sessionId.slice(-4)} cwd=${shortPath(routeBinding.cwd || this.options.defaultWorkdir)} source=${sessionTarget.source}`,
    );

    const reactions = adapter.getLifecycleReactions();
    adapter.addReaction(msg.chatId, msg.messageId, reactions.processing).catch(() => {});

    let typingInterval = setInterval(() => adapter.sendTyping(msg.chatId).catch(() => {}), 4000);
    adapter.sendTyping(msg.chatId).catch(() => {});

    const costTracker = new CostTracker();
    costTracker.start();

    // Retry logic for stale session
    let attemptCount = 0;
    let resumeFallbackMessage: string | undefined;
    const maxAttempts = 2; // Try once with resume, then once fresh

    while (attemptCount < maxAttempts) {
      attemptCount++;
      const currentBinding = attemptCount > 1 && sessionTarget.source === 'current'
        ? await this.options.router.resolve(msg.channelType, scopeId)
        : routeBinding;
      if (attemptCount > 1 && sessionTarget.source === 'current') {
        routeBinding = currentBinding;
      }

      const { renderer, presenter } = this.createRendererAndPresenter(adapter, msg, currentBinding, reactions, typingInterval);

      // Create SDK handlers
      const permissionHandler = new SDKPermissionHandler({
        adapter,
        msg,
        binding: currentBinding,
        permissions: this.options.permissions,
        state: this.options.state,
        router: this.options.router,
        renderer,
        reactions,
        askQuestionApproved: false,
      });

      const askQuestionHandler = new SDKAskQuestionHandler({
        adapter,
        msg,
        binding: currentBinding,
        permissions: this.options.permissions,
        interactionState: this.options.sdkEngine.getInteractionState(),
      });

      const deferredToolHandler = new SDKDeferredToolHandler({
        adapter,
        msg,
        binding: currentBinding,
        permissions: this.options.permissions,
        interactionState: this.options.sdkEngine.getInteractionState(),
      });

      // Wire up askQuestionApproved: when AskUserQuestion approved, auto-allow next tool
      askQuestionHandler.setOnApproved(() => permissionHandler.setAskQuestionApproved(true));

      const sdkPermissionHandler = permissionHandler.handle.bind(permissionHandler);
      const sdkAskQuestionHandler = askQuestionHandler.handle.bind(askQuestionHandler);
      const sdkDeferredToolHandler = deferredToolHandler.handle.bind(deferredToolHandler);

      try {
        const queryCtx = new QueryContext(
          adapter,
          msg,
          currentBinding,
          sessionTarget.sessionKey,
          renderer,
          costTracker,
          sdkPermissionHandler,
          sdkAskQuestionHandler,
          sdkDeferredToolHandler,
          ctx,
        );
        await this.executeQuery(queryCtx);

        // Track progress bubble → session for multi-session steering
        if (renderer.messageId) {
          this.options.sdkEngine.setActiveMessageId(
            this.options.state.stateKey(msg.channelType, scopeId),
            renderer.messageId,
            sessionTarget.sessionKey,
          );
          this.recordTopicSession(msg, currentBinding, {
            sdkSessionId: currentBinding.sdkSessionId,
            lastMessageId: renderer.messageId,
          });
          console.log(`[query] ${ctx.requestId} SENT msgId=${renderer.messageId.slice(-8)}`);
        }

        // Show resume fallback message if we recovered from stale session
        if (resumeFallbackMessage && renderer.messageId) {
          // Send as a separate message after the turn completes
          adapter.send(withInboundReplyContext({ chatId: msg.chatId, text: resumeFallbackMessage }, msg)).catch(() => {});
        }

        adapter.addReaction(msg.chatId, msg.messageId, reactions.done).catch(() => {});
        if (renderer.messageId) {
          adapter.addReaction(msg.chatId, renderer.messageId, reactions.done).catch(() => {});
        }

        // Success - break out of retry loop
        break;
      } catch (err) {
        // Check if this is a stale session error - retry with fresh session
        if (err instanceof SessionStaleError && attemptCount < maxAttempts) {
          console.log(`[query] ${ctx.requestId} SESSION_STALE retrying with fresh session`);
          resumeFallbackMessage = '🔄 旧会话无法恢复，已为你开启新会话';

          // Clear sdkSessionId and recycle the stale live session
          currentBinding.sdkSessionId = undefined;
          this.options.sdkEngine.updateSessionSdkSessionId?.(sessionTarget.sessionKey, undefined);
          this.options.sdkEngine.resetSessionRuntime?.(sessionTarget.sessionKey, 'expire');
          sessionTarget = { ...sessionTarget, sdkSessionId: undefined };
          routeBinding = { ...currentBinding };
          if (sessionTarget.source === 'current') {
            await this.options.store.saveBinding(currentBinding);
          }

          // Send task start notification card for stale session recovery
          const staleTaskStartMsg = adapter.format({
            type: 'taskStart',
            chatId: msg.chatId,
            data: {
              cwd: shortPath(currentBinding.cwd || this.options.defaultWorkdir),
              permissionMode: this.options.state.getPermMode(msg.channelType, scopeId, currentBinding.sessionId),
              isNewSession: true,
              reason: 'stale',
            },
          });
          await adapter.send(withInboundReplyContext(staleTaskStartMsg, msg));

          // Continue to next iteration with fresh binding
          clearInterval(typingInterval);
          renderer.dispose();
          await presenter.dispose();
          this.options.sdkEngine.setControlsForChat(
            this.options.state.stateKey(msg.channelType, scopeId),
            undefined,
            sessionTarget.sessionKey,
          );

          // Restart typing indicator for retry
          typingInterval = setInterval(() => adapter.sendTyping(msg.chatId).catch(() => {}), 4000);
          adapter.sendTyping(msg.chatId).catch(() => {});
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
        clearInterval(typingInterval);
        // Note: renderer and presenter cleanup happens inside the loop for retry cases
      }
    }

    // Final cleanup (only if we exited the loop successfully)
    clearInterval(typingInterval);

    return true;
  }

  private async ensureThreadScope(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<InboundMessage> {
    if (
      msg.threadId
      || msg.callbackData
      || !msg.messageId
      || typeof (adapter as any).startThreadFromMessage !== 'function'
    ) {
      return msg;
    }

    const started = await adapter.startThreadFromMessage(
      msg.chatId,
      msg.messageId,
      '💬 已开启话题，正在处理...',
    ).catch((err) => {
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
      threadRootMessageId: started.messageId,
      threadParentMessageId: started.messageId,
    };
  }

  private async claimThreadSession(
    msg: InboundMessage,
    scopeId: string,
    binding: ChannelBinding,
    allowClaim: boolean,
  ): Promise<{
    binding: ChannelBinding;
    target: {
      sessionKey: string;
      bindingSessionId: string;
      workdir: string;
      sdkSessionId?: string;
      source: 'reply' | 'current';
    };
  } | null> {
    if (!allowClaim || !msg.threadId) return null;

    const candidates = [
      msg.replyToMessageId,
      msg.threadParentMessageId,
      msg.threadRootMessageId,
    ].filter((id): id is string => !!id);

    for (const messageId of candidates) {
      const sessionKey = this.options.sdkEngine.getSessionForBubble?.(messageId);
      const managed = sessionKey ? this.options.sdkEngine.getSessionContext?.(sessionKey) : undefined;
      if (!sessionKey || !managed) continue;

      const oldBinding = await this.options.store.getBinding(managed.channelType, managed.chatId);
      const movedKey = managed.chatId === scopeId
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
        cwd: moved.workdir,
        claudeSettingSources: oldBinding?.claudeSettingSources ?? binding.claudeSettingSources,
        projectName: oldBinding?.projectName ?? binding.projectName,
        createdAt: binding.createdAt,
      };
      await this.options.store.saveBinding(topicBinding);
      this.recordTopicSession(msg, topicBinding, {
        sdkSessionId: moved.sdkSessionId,
        lastMessageId: candidates[0],
      });

      if (oldBinding && oldBinding.chatId !== scopeId && oldBinding.sessionId === moved.bindingSessionId) {
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
          source: 'current',
        },
      };
    }

    return null;
  }

  private createRendererAndPresenter(
    adapter: BaseChannelAdapter,
    msg: InboundMessage,
    binding: { cwd?: string; sdkSessionId?: string },
    reactions: { permission: string; processing: string; stalled: string },
    typingInterval: ReturnType<typeof setInterval>,
  ): { renderer: MessageRenderer; presenter: QueryExecutionPresenter } {
    let stalledReactionAdded = false;
    let renderer!: MessageRenderer;
    const getProgressMessageId = (): string | undefined => renderer?.messageId;

    const presenter = new QueryExecutionPresenter({
      adapter,
      inbound: msg,
      platformLimit: PLATFORM_LIMITS[adapter.channelType as ChannelType] ?? 4096,
      clearTyping: () => clearInterval(typingInterval),
      getMessageId: getProgressMessageId,
    });

    renderer = new MessageRenderer({
      shouldSplitState: (state) => this.shouldSplitProgressBubble(adapter, msg, state),
      platformLimit: PLATFORM_LIMITS[adapter.channelType as ChannelType] ?? 4096,
      throttleMs: 300,
      cwd: binding.cwd || this.options.defaultWorkdir,
      sessionId: binding.sdkSessionId,
      onPermissionReaction: () => {
        if (renderer.messageId) {
          adapter.addReaction(msg.chatId, renderer.messageId, reactions.permission).catch(() => {});
        }
      },
      onPermissionReactionClear: () => {
        if (renderer.messageId) {
          adapter.addReaction(msg.chatId, renderer.messageId, reactions.processing).catch(() => {});
        }
      },
      onProgressStalled: () => {
        if (renderer.messageId && !stalledReactionAdded) {
          stalledReactionAdded = true;
          adapter.addReaction(msg.chatId, renderer.messageId, reactions.stalled).catch(() => {});
        }
      },
      onProgressResumed: () => {
        if (renderer.messageId && stalledReactionAdded) {
          stalledReactionAdded = false;
          adapter.addReaction(msg.chatId, renderer.messageId, reactions.processing).catch(() => {});
        }
      },
      onFlushError: (error, context) => {
        // Notify user when flush fails (e.g., platform limit exceeded)
        const errorMsg = error.message || String(error);
        const locale = typeof adapter.getLocale === 'function' ? adapter.getLocale() : 'zh';
        const phaseText = context.phase === 'completed'
          ? t(locale, 'progress.phaseCompleted')
          : context.phase === 'failed'
            ? t(locale, 'progress.phaseFailed')
            : t(locale, 'progress.phaseRunning');
        const notifyMsg = adapter.format({
          type: 'error',
          chatId: msg.chatId,
          data: {
            title: `${t(locale, 'format.flushErrorTitle')} (${phaseText})`,
            message: `${errorMsg.slice(0, 150)}\n\n${t(locale, 'format.flushErrorHint')}`,
          },
        });
        adapter.send(withInboundReplyContext(notifyMsg, msg)).catch(() => {});
      },
      flushCallback: (content, isEdit, buttons, state) => presenter.flush(content, isEdit, buttons, state),
    });

    return { renderer, presenter };
  }

  private recordTopicSession(
    msg: InboundMessage,
    binding: { channelType?: string; chatId?: string; cwd?: string; sdkSessionId?: string },
    updates: { sdkSessionId?: string; lastMessageId?: string } = {},
  ): void {
    if (!msg.threadId || !this.options.topicSessions) return;
    const scopeId = messageScopeId(msg);
    const preview = truncate((msg.text || '').trim() || 'Claude 会话', 120);
    this.options.topicSessions.upsert({
      channelType: msg.channelType,
      chatId: msg.chatId,
      scopeId,
      threadId: msg.threadId,
      rootMessageId: msg.threadRootMessageId ?? msg.replyTargetMessageId,
      lastMessageId: updates.lastMessageId ?? msg.replyTargetMessageId ?? msg.messageId,
      sdkSessionId: updates.sdkSessionId ?? binding.sdkSessionId,
      cwd: binding.cwd || this.options.defaultWorkdir,
      title: preview,
      preview,
    });
  }

  private shouldSplitProgressBubble(
    adapter: BaseChannelAdapter,
    inbound: InboundMessage,
    state: MessageRendererState,
  ): boolean {
    const locale = typeof adapter.getLocale === 'function' ? adapter.getLocale() : 'zh';
    const progressData = buildProgressData(state, inbound.text || t(locale, 'format.continueTask'));
    const outMsg = adapter.format({ type: 'progress', chatId: inbound.chatId, data: progressData });
    return adapter.shouldSplitProgressMessage(outMsg);
  }

  private async executeQuery(qctx: QueryContext): Promise<void> {
    const { adapter, msg, binding, sessionKey, renderer, costTracker, sdkPermissionHandler, sdkAskQuestionHandler, sdkDeferredToolHandler, ctx } = qctx;
    const workdir = binding.cwd || this.options.defaultWorkdir;
    const settingSources = binding.claudeSettingSources ?? this.options.defaultClaudeSettingSources;
    const scopeId = messageScopeId(msg);
    const chatKey = this.options.state.stateKey(msg.channelType, scopeId);

    let liveSession: LiveSession | undefined;
    let streamResult: import('../../providers/base.js').StreamChatResult | undefined;

    try {
      liveSession = this.options.sdkEngine.getOrCreateSession(
        this.options.llm,
        msg.channelType,
        scopeId,
        binding.sessionId,
        workdir,
        {
          sessionId: binding.sdkSessionId,
          settingSources,
          appendSystemPrompt: this.options.appendSystemPrompt,
          setAsCurrent: sessionKey === this.options.sdkEngine.getActiveSessionKey?.(msg.channelType, scopeId),
        },
      );
    } catch (err) {
      console.warn(`[bridge] Failed to create LiveSession, falling back to streamChat: ${err}`);
    }

    if (liveSession) {
      streamResult = liveSession.startTurn(msg.text, {
        onPermissionRequest: sdkPermissionHandler,
        onAskUserQuestion: sdkAskQuestionHandler,
        onDeferredTool: sdkDeferredToolHandler,
        attachments: msg.attachments?.filter(a => a.type === 'image'),
      });
    }

    await this.options.engine.processMessage({
      sdkSessionId: binding.sdkSessionId,
      workingDirectory: workdir,
      settingSources,
      text: msg.text,
      attachments: msg.attachments,
      streamResult,
      sdkPermissionHandler: streamResult ? undefined : sdkPermissionHandler,
      sdkAskQuestionHandler: streamResult ? undefined : sdkAskQuestionHandler,
      sdkDeferredToolHandler: streamResult ? undefined : sdkDeferredToolHandler,
      onControls: (ctrl) => this.options.sdkEngine.setControlsForChat(chatKey, ctrl, sessionKey),
      onSdkSessionId: async (id) => {
        binding.sdkSessionId = id;
        this.options.sdkEngine.updateSessionSdkSessionId?.(sessionKey, id);
        if (binding.channelType === msg.channelType && binding.chatId === scopeId) {
          const currentBinding = await this.options.store.getBinding(msg.channelType, scopeId);
          if (currentBinding?.sessionId === binding.sessionId) {
            currentBinding.sdkSessionId = id;
            await this.options.store.saveBinding(currentBinding);
          }
        }
        this.recordTopicSession(msg, binding, { sdkSessionId: id });
      },
      onTextDelta: (delta) => renderer.onTextDelta(delta),
      onThinkingDelta: (delta) => renderer.onThinkingDelta(delta),
      onToolStart: (event) => renderer.onToolStart(event.name, event.input, event.id),
      onToolResult: (event) => {
        renderer.onToolResult(event.toolUseId, event.content, event.isError);
        renderer.onToolComplete(event.toolUseId);
      },
      onAgentStart: (data) => {
        if (DEBUG_EVENTS) console.log(`[bridge] agent_start: ${data.description}`);
        renderer.onToolStart('Agent', { description: data.description, prompt: '' });
      },
      onAgentProgress: (data) => {
        if (DEBUG_EVENTS) console.log(`[bridge] agent_progress: ${data.description}`);
        if (data.usage?.durationMs) {
          renderer.onToolProgress({ toolName: 'Agent', elapsed: data.usage.durationMs });
        }
      },
      onAgentComplete: () => renderer.onToolComplete('agent-complete'),
      onToolProgress: (data) => renderer.onToolProgress(data),
      onStatus: (data) => renderer.setModel(data.model),
      onSessionInfo: (data) => renderer.onSessionInfo(data),
      onToolUseSummary: (summary) => renderer.onToolUseSummary(summary),
      onSessionState: (state) => {
        if (DEBUG_EVENTS) console.log(`[bridge] session_state: ${state}`);
      },
      onApiRetry: (data) => {
        console.log(`[bridge] api_retry: attempt ${data.attempt}/${data.maxRetries} delay=${data.retryDelayMs}ms${data.error ? ` error=${data.error}` : ''}`);
        renderer.onApiRetry(data);
      },
      onCompactBoundary: (data) => {
        console.log(`[bridge] compact_boundary: trigger=${data.trigger}${data.preTokens ? ` pre_tokens=${data.preTokens}` : ''}`);
        renderer.onCompacting(true);
      },
      onRateLimit: (data) => {
        if (data.status === 'rejected') {
          renderer.onTextDelta('\n⚠️ Rate limited. Retrying...\n');
        } else if (data.status === 'allowed_warning' && data.utilization) {
          renderer.onTextDelta(`\n⚠️ Rate limit: ${Math.round(data.utilization * 100)}% used\n`);
        }
      },
      onTodoUpdate: (todos) => renderer.onTodoUpdate(todos),
      onQueryResult: async (event) => {
        if (event.permissionDenials?.length) {
          console.warn(`[query] ${ctx.requestId} DENIALS ${event.permissionDenials.map(denial => denial.toolName).join(', ')}`);
        }
        costTracker.finish({
          input_tokens: event.usage.inputTokens,
          output_tokens: event.usage.outputTokens,
          cost_usd: event.usage.costUsd,
        });
        console.log(`[query] ${ctx.requestId} COMPLETE tokens=${event.usage.inputTokens}+${event.usage.outputTokens} cost=${event.usage.costUsd?.toFixed(4) || '?'}$`);
        // Invalidate session cache so next home/sessions shows latest task
        invalidateSessionCache();
        if (DEBUG_EVENTS) {
          const state = renderer.getDebugSnapshot();
          console.log(`[bridge] final timeline: thinking=${state.thinkingEntries} text=${state.textEntries} tool=${state.toolEntries}`);
        }
        await renderer.onComplete();
      },
      onPromptSuggestion: (suggestion) => {
        const truncated = truncate(suggestion, 60);
        adapter.send(withInboundReplyContext({
          chatId: msg.chatId,
          text: `💡 ${truncated}`,
          buttons: [{ label: `💡 ${truncated}`, callbackData: `suggest:${suggestion.slice(0, 200)}`, style: 'default' as const }],
        }, msg)).catch(() => {});
      },
      onError: async (err) => {
        // Check for stale session error - throw special error for retry
        if (isStaleSessionError(err)) {
          console.log(`[query] ${ctx.requestId} SESSION_STALE detected`);
          throw new SessionStaleError(err);
        }
        console.error(`[query] ${ctx.requestId} ERROR ${err.slice(0, 200)}`);
        // Invalidate session cache on error too (task ended)
        invalidateSessionCache();
        if (DEBUG_EVENTS) {
          const state = renderer.getDebugSnapshot();
          console.log(`[bridge] error timeline: thinking=${state.thinkingEntries} text=${state.textEntries} tool=${state.toolEntries}`);
        }
        await renderer.onError(err);
      },
    });
  }
}
