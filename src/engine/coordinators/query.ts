import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import { MessageRenderer } from '../messages/renderer.js';
import { CostTracker } from '../utils/cost-tracker.js';
import type { ConversationEngine } from '../utils/conversation.js';
import type { ChannelRouter } from '../utils/router.js';
import type { SessionStateManager } from '../state/session-state.js';
import type { PermissionCoordinator } from './permission.js';
import type { SDKEngine } from '../sdk/engine.js';
import { PLATFORM_LIMITS, type ChannelType } from '../../utils/constants.js';
import { generateSessionId } from '../../utils/id.js';
import { truncate } from '../../utils/string.js';
import { shortPath } from '../../utils/path.js';
import { scanClaudeSessions } from '../../session-scanner.js';
import type { BridgeStore, ChannelBinding } from '../../store/interface.js';
import type { ClaudeSettingSource } from '../../config.js';
import { Logger, type LogContext } from '../../logger.js';
import type { LLMProvider, LiveSession } from '../../providers/base.js';
import { QueryExecutionPresenter } from '../messages/query-presenter.js';
import { SDKPermissionHandler } from '../sdk/permission-handler.js';
import { SDKAskQuestionHandler } from '../sdk/ask-question-handler.js';
import type { ProgressData } from '../../formatting/message-types.js';
import { buildProgressData } from '../messages/progress-builder.js';
import type { MessageRendererState } from '../messages/renderer.js';
import { SessionStaleError, isStaleSessionError } from '../state/session-stale-error.js';

const DEBUG_EVENTS = process.env.TL_DEBUG_EVENTS === '1';

interface QueryOrchestratorOptions {
  engine: ConversationEngine;
  llm: LLMProvider;
  router: ChannelRouter;
  state: SessionStateManager;
  permissions: PermissionCoordinator;
  sdkEngine: SDKEngine;
  store: BridgeStore;
  defaultWorkdir: string;
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
    const ctx: LogContext = { requestId, chatId: msg.chatId };
    const expired = this.options.state.checkAndUpdateLastActive(msg.channelType, msg.chatId);
    let previousSessionPreview: string | undefined;
    if (expired) {
      const previousBinding = await this.options.store.getBinding(msg.channelType, msg.chatId);
      this.options.permissions.clearSessionWhitelist(previousBinding?.sessionId);
      console.log(`[query] ${ctx.requestId} SESSION_EXPIRED sid=${previousBinding?.sessionId?.slice(-4) || '?'}`);
      // Get preview of previous session before rebind
      const sessions = scanClaudeSessions(3, previousBinding?.cwd || this.options.defaultWorkdir);
      previousSessionPreview = sessions.find(s => s.sdkSessionId === previousBinding?.sdkSessionId)?.preview;
      await this.options.router.rebind(msg.channelType, msg.chatId, generateSessionId(), {
        cwd: previousBinding?.cwd,
        claudeSettingSources: previousBinding?.claudeSettingSources,
        projectName: previousBinding?.projectName,
      });
      this.options.state.clearThread(msg.channelType, msg.chatId);
    }

    const binding = await this.options.router.resolve(msg.channelType, msg.chatId);
    ctx.sessionId = binding.sessionId;
    console.log(`[query] ${ctx.requestId} START session=${binding.sessionId.slice(-4)} cwd=${shortPath(binding.cwd || this.options.defaultWorkdir)}`);

    // Send task start notification card for session reset
    if (expired) {
      const taskStartMsg = adapter.format({
        type: 'taskStart',
        chatId: msg.chatId,
        data: {
          cwd: shortPath(binding.cwd || this.options.defaultWorkdir),
          permissionMode: this.options.state.getPermMode(msg.channelType, msg.chatId),
          isNewSession: true,
          previousSessionPreview,
          reason: 'idle',
        },
      });
      await adapter.send(taskStartMsg);
    }

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
      const currentBinding = attemptCount > 1 ? await this.options.router.resolve(msg.channelType, msg.chatId) : binding;

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

      // Wire up askQuestionApproved: when AskUserQuestion approved, auto-allow next tool
      askQuestionHandler.setOnApproved(() => permissionHandler.setAskQuestionApproved(true));

      const sdkPermissionHandler = permissionHandler.handle.bind(permissionHandler);
      const sdkAskQuestionHandler = askQuestionHandler.handle.bind(askQuestionHandler);

      try {
        await this.executeQuery(adapter, msg, currentBinding, renderer, costTracker, sdkPermissionHandler, sdkAskQuestionHandler, ctx);

        // Track progress bubble → session for multi-session steering
        const chatKey = this.options.state.stateKey(msg.channelType, msg.chatId);
        const workdir = currentBinding.cwd || this.options.defaultWorkdir;
        const sessionKey = `${msg.channelType}:${msg.chatId}:${workdir}`;
        if (renderer.messageId) {
          this.options.sdkEngine.setActiveMessageId(chatKey, renderer.messageId, sessionKey);
          console.log(`[query] ${ctx.requestId} SENT msgId=${renderer.messageId.slice(-8)}`);
        }

        // Show resume fallback message if we recovered from stale session
        if (resumeFallbackMessage && renderer.messageId) {
          // Send as a separate message after the turn completes
          adapter.send({ chatId: msg.chatId, text: resumeFallbackMessage }).catch(() => {});
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

          // Clear sdkSessionId and close the stale session
          currentBinding.sdkSessionId = undefined;
          await this.options.store.saveBinding(currentBinding);
          this.options.sdkEngine.cleanupSession(msg.channelType, msg.chatId, 'expire', currentBinding.cwd);
          this.options.permissions.clearSessionWhitelist(currentBinding.sessionId);

          // Send task start notification card for stale session recovery
          const staleTaskStartMsg = adapter.format({
            type: 'taskStart',
            chatId: msg.chatId,
            data: {
              cwd: shortPath(currentBinding.cwd || this.options.defaultWorkdir),
              permissionMode: this.options.state.getPermMode(msg.channelType, msg.chatId),
              isNewSession: true,
              reason: 'stale',
            },
          });
          await adapter.send(staleTaskStartMsg);

          // Continue to next iteration with fresh binding
          clearInterval(typingInterval);
          renderer.dispose();
          await presenter.dispose();
          this.options.sdkEngine.setControlsForChat(
            this.options.state.stateKey(msg.channelType, msg.chatId),
            undefined,
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
        const phaseText = context.phase === 'completed' ? '完成时' : context.phase === 'failed' ? '失败时' : '执行中';
        const notifyMsg = adapter.format({
          type: 'error',
          chatId: msg.chatId,
          data: {
            title: `消息发送失败 (${phaseText})`,
            message: `${errorMsg.slice(0, 150)}\n\n可能原因：内容超出平台限制（如表格行数、消息长度）。`,
          },
        });
        adapter.send(notifyMsg).catch(() => {});
      },
      flushCallback: (content, isEdit, buttons, state) => presenter.flush(content, isEdit, buttons, state),
    });

    return { renderer, presenter };
  }

  private shouldSplitProgressBubble(
    adapter: BaseChannelAdapter,
    inbound: InboundMessage,
    state: MessageRendererState,
  ): boolean {
    const progressData = buildProgressData(state, inbound.text || '继续当前任务');
    const outMsg = adapter.format({ type: 'progress', chatId: inbound.chatId, data: progressData });
    return adapter.shouldSplitProgressMessage(outMsg);
  }

  private async executeQuery(
    adapter: BaseChannelAdapter,
    msg: InboundMessage,
    binding: ChannelBinding,
    renderer: MessageRenderer,
    costTracker: CostTracker,
    sdkPermissionHandler: (toolName: string, toolInput: Record<string, unknown>, promptSentence: string, signal?: AbortSignal) => Promise<'allow' | 'allow_always' | 'deny'>,
    sdkAskQuestionHandler: (questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean }>, signal?: AbortSignal) => Promise<Record<string, string>>,
    ctx: LogContext,
  ): Promise<void> {
    const workdir = binding.cwd || this.options.defaultWorkdir;
    const settingSources = binding.claudeSettingSources ?? this.options.defaultClaudeSettingSources;
    const chatKey = this.options.state.stateKey(msg.channelType, msg.chatId);

    let liveSession: LiveSession | undefined;
    let streamResult: import('../../providers/base.js').StreamChatResult | undefined;

    try {
      liveSession = this.options.sdkEngine.getOrCreateSession(
        this.options.llm,
        msg.channelType,
        msg.chatId,
        workdir,
        { sessionId: binding.sdkSessionId, settingSources, appendSystemPrompt: this.options.appendSystemPrompt },
      );
    } catch (err) {
      console.warn(`[bridge] Failed to create LiveSession, falling back to streamChat: ${err}`);
    }

    if (liveSession) {
      streamResult = liveSession.startTurn(msg.text, {
        onPermissionRequest: sdkPermissionHandler,
        onAskUserQuestion: sdkAskQuestionHandler,
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
      onControls: (ctrl) => this.options.sdkEngine.setControlsForChat(chatKey, ctrl),
      onSdkSessionId: async (id) => {
        binding.sdkSessionId = id;
        await this.options.store.saveBinding(binding);
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
        if (DEBUG_EVENTS) {
          const state = renderer.getDebugSnapshot();
          console.log(`[bridge] final timeline: thinking=${state.thinkingEntries} text=${state.textEntries} tool=${state.toolEntries}`);
        }
        await renderer.onComplete();
      },
      onPromptSuggestion: (suggestion) => {
        const truncated = truncate(suggestion, 60);
        adapter.send({
          chatId: msg.chatId,
          text: `💡 ${truncated}`,
          buttons: [{ label: `💡 ${truncated}`, callbackData: `suggest:${suggestion.slice(0, 200)}`, style: 'default' as const }],
        }).catch(() => {});
      },
      onError: async (err) => {
        // Check for stale session error - throw special error for retry
        if (isStaleSessionError(err)) {
          console.log(`[query] ${ctx.requestId} SESSION_STALE detected`);
          throw new SessionStaleError(err);
        }
        console.error(`[query] ${ctx.requestId} ERROR ${err.slice(0, 200)}`);
        if (DEBUG_EVENTS) {
          const state = renderer.getDebugSnapshot();
          console.log(`[bridge] error timeline: thinking=${state.thinkingEntries} text=${state.textEntries} tool=${state.toolEntries}`);
        }
        await renderer.onError(err);
      },
    });
  }
}
