import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';
import { MessageRenderer } from './message-renderer.js';
import { CostTracker } from './cost-tracker.js';
import type { ConversationEngine } from './conversation.js';
import type { ChannelRouter } from './router.js';
import type { SessionStateManager } from './session-state.js';
import type { PermissionCoordinator } from './permission-coordinator.js';
import type { SDKEngine } from './sdk-engine.js';
import { CHANNEL_TYPES, PLATFORM_LIMITS, PLATFORM_REACTIONS, type ChannelType } from '../utils/constants.js';
import { generateSessionId } from '../utils/id.js';
import { truncate } from '../utils/string.js';
import { shortPath } from '../utils/path.js';
import { scanClaudeSessions } from '../session-scanner.js';
import type { BridgeStore, ChannelBinding } from '../store/interface.js';
import type { ClaudeSettingSource } from '../config.js';
import type { LLMProvider, LiveSession } from '../providers/base.js';
import { QueryExecutionPresenter } from './query-execution-presenter.js';
import { SDKPermissionHandler } from './sdk-permission-handler.js';
import { SDKAskQuestionHandler } from './sdk-ask-question-handler.js';

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
}

/**
 * Executes the full Claude query lifecycle for one inbound message:
 * binding/session rotation, renderer + typing lifecycle, SDK permission hooks,
 * and final reaction/cleanup handling.
 */
export class QueryOrchestrator {
  constructor(private options: QueryOrchestratorOptions) {}

  async run(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    const { binding, expired, previousSessionPreview } = await this.handleSessionExpiry(adapter, msg);

    // Send task start notification card for session reset
    if (expired && adapter.supportsRichCards()) {
      const taskStartMsg = adapter.format({
        type: 'taskStart',
        chatId: msg.chatId,
        data: {
          cwd: shortPath(binding.cwd || this.options.defaultWorkdir),
          permissionMode: this.options.state.getPermMode(msg.channelType, msg.chatId),
          isNewSession: true,
          previousSessionPreview,
        },
      });
      await adapter.send(taskStartMsg);
    }

    const reactions = PLATFORM_REACTIONS[adapter.channelType as ChannelType] ?? PLATFORM_REACTIONS[CHANNEL_TYPES.TELEGRAM];
    adapter.addReaction(msg.chatId, msg.messageId, reactions.processing).catch(() => {});

    const typingInterval = setInterval(() => adapter.sendTyping(msg.chatId).catch(() => {}), 4000);
    adapter.sendTyping(msg.chatId).catch(() => {});

    const costTracker = new CostTracker();
    costTracker.start();

    const { renderer, presenter } = this.createRendererAndPresenter(adapter, msg, binding, reactions, typingInterval);

    // Create SDK handlers
    const permissionHandler = new SDKPermissionHandler({
      adapter,
      msg,
      binding,
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
      binding,
      permissions: this.options.permissions,
      interactionState: this.options.sdkEngine.getInteractionState(),
    });

    // Wire up askQuestionApproved: when AskUserQuestion approved, auto-allow next tool
    askQuestionHandler.setOnApproved(() => permissionHandler.setAskQuestionApproved(true));

    const sdkPermissionHandler = permissionHandler.handle.bind(permissionHandler);
    const sdkAskQuestionHandler = askQuestionHandler.handle.bind(askQuestionHandler);

    try {
      await this.executeQuery(adapter, msg, binding, renderer, costTracker, sdkPermissionHandler, sdkAskQuestionHandler);

      // Track progress bubble → session for multi-session steering
      const chatKey = this.options.state.stateKey(msg.channelType, msg.chatId);
      const workdir = binding.cwd || this.options.defaultWorkdir;
      const sessionKey = `${msg.channelType}:${msg.chatId}:${workdir}`;
      if (renderer.messageId) {
        this.options.sdkEngine.setActiveMessageId(chatKey, renderer.messageId, sessionKey);
      }

      adapter.addReaction(msg.chatId, msg.messageId, reactions.done).catch(() => {});
      if (renderer.messageId) {
        adapter.addReaction(msg.chatId, renderer.messageId, reactions.done).catch(() => {});
      }
    } catch (err) {
      adapter.addReaction(msg.chatId, msg.messageId, reactions.error).catch(() => {});
      if (renderer.messageId) {
        adapter.addReaction(msg.chatId, renderer.messageId, reactions.error).catch(() => {});
      }
      throw err;
    } finally {
      clearInterval(typingInterval);
      renderer.dispose();
      await presenter.dispose();
      this.options.sdkEngine.setControlsForChat(
        this.options.state.stateKey(msg.channelType, msg.chatId),
        undefined,
      );
    }

    return true;
  }

  // --- Private helpers ---

  private async handleSessionExpiry(
    adapter: BaseChannelAdapter,
    msg: InboundMessage,
  ): Promise<{
    binding: ChannelBinding;
    expired: boolean;
    previousSessionPreview?: string;
  }> {
    const expired = this.options.state.checkAndUpdateLastActive(msg.channelType, msg.chatId);
    let previousSessionPreview: string | undefined;

    if (expired) {
      const previousBinding = await this.options.store.getBinding(msg.channelType, msg.chatId);
      this.options.permissions.clearSessionWhitelist(previousBinding?.sessionId);

      const sessions = scanClaudeSessions(3, previousBinding?.cwd || this.options.defaultWorkdir);
      previousSessionPreview = sessions.find(s => s.sdkSessionId === previousBinding?.sdkSessionId)?.preview;

      await this.options.router.rebind(msg.channelType, msg.chatId, generateSessionId(), {
        cwd: previousBinding?.cwd,
        claudeSettingSources: previousBinding?.claudeSettingSources,
      });
      this.options.state.clearThread(msg.channelType, msg.chatId);
    }

    const binding = await this.options.router.resolve(msg.channelType, msg.chatId);
    return { binding, expired, previousSessionPreview };
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
      flushCallback: (content, isEdit, buttons, state) => presenter.flush(content, isEdit, buttons, state),
    });

    return { renderer, presenter };
  }

  private async executeQuery(
    adapter: BaseChannelAdapter,
    msg: InboundMessage,
    binding: ChannelBinding,
    renderer: MessageRenderer,
    costTracker: CostTracker,
    sdkPermissionHandler: (toolName: string, toolInput: Record<string, unknown>, promptSentence: string, signal?: AbortSignal) => Promise<'allow' | 'allow_always' | 'deny'>,
    sdkAskQuestionHandler: (questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean }>, signal?: AbortSignal) => Promise<Record<string, string>>,
  ): Promise<void> {
    const workdir = binding.cwd || this.options.defaultWorkdir;
    const settingSources = binding.claudeSettingSources ?? this.options.defaultClaudeSettingSources;
    const chatKey = this.options.state.stateKey(msg.channelType, msg.chatId);

    let liveSession: LiveSession | undefined;
    let streamResult: import('../providers/base.js').StreamChatResult | undefined;

    try {
      liveSession = this.options.sdkEngine.getOrCreateSession(
        this.options.llm,
        msg.channelType,
        msg.chatId,
        workdir,
        { sessionId: binding.sdkSessionId, settingSources },
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
          console.warn(`[bridge] Permission denials: ${event.permissionDenials.map(d => d.toolName).join(', ')}`);
        }
        costTracker.finish({
          input_tokens: event.usage.inputTokens,
          output_tokens: event.usage.outputTokens,
          cost_usd: event.usage.costUsd,
        });
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
        if (err.includes('No conversation found') || err.includes('session ID') || (err.includes('Invalid') && err.includes('signature'))) {
          console.log(`[bridge] Session expired or stale, clearing for ${msg.channelType}:${msg.chatId}`);
          binding.sdkSessionId = undefined;
          await this.options.store.saveBinding(binding);
          this.options.sdkEngine.closeSession(msg.channelType, msg.chatId);
        }
        if (DEBUG_EVENTS) {
          const state = renderer.getDebugSnapshot();
          console.log(`[bridge] error timeline: thinking=${state.thinkingEntries} text=${state.textEntries} tool=${state.toolEntries}`);
        }
        await renderer.onError(err);
      },
    });
  }
}