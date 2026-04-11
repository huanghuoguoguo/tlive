import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';
import { MessageRenderer } from './message-renderer.js';
import { getToolCommand } from './tool-registry.js';
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
import type { BridgeStore } from '../store/interface.js';
import type { ClaudeSettingSource } from '../config.js';
const DEBUG_EVENTS = process.env.TL_DEBUG_EVENTS === '1';
import type { LLMProvider, LiveSession } from '../providers/base.js';
import { QueryExecutionPresenter } from './query-execution-presenter.js';

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
    const expired = this.options.state.checkAndUpdateLastActive(msg.channelType, msg.chatId);
    let previousSessionPreview: string | undefined;
    if (expired) {
      const previousBinding = await this.options.store.getBinding(msg.channelType, msg.chatId);
      this.options.permissions.clearSessionWhitelist(previousBinding?.sessionId);
      // Get preview of previous session before rebind
      const sessions = scanClaudeSessions(3, previousBinding?.cwd || this.options.defaultWorkdir);
      previousSessionPreview = sessions.find(s => s.sdkSessionId === previousBinding?.sdkSessionId)?.preview;
      await this.options.router.rebind(msg.channelType, msg.chatId, generateSessionId(), {
        cwd: previousBinding?.cwd,
        claudeSettingSources: previousBinding?.claudeSettingSources,
      });
      this.options.state.clearThread(msg.channelType, msg.chatId);
    }

    const binding = await this.options.router.resolve(msg.channelType, msg.chatId);

    // Send task start notification card for session reset (Feishu rich cards only)
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

    const reactionChatId = msg.chatId;
    const typingInterval = setInterval(() => {
      adapter.sendTyping(msg.chatId).catch(() => {});
    }, 4000);
    adapter.sendTyping(msg.chatId).catch(() => {});

    const costTracker = new CostTracker();
    costTracker.start();

    const reactions = PLATFORM_REACTIONS[adapter.channelType as ChannelType] ?? PLATFORM_REACTIONS[CHANNEL_TYPES.TELEGRAM];
    adapter.addReaction(reactionChatId, msg.messageId, reactions.processing).catch(() => {});

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
        // Add 🔐 reaction on the progress message to notify user
        const progressMsgId = renderer.messageId;
        if (progressMsgId) {
          adapter.addReaction(msg.chatId, progressMsgId, reactions.permission).catch(() => {});
        }
      },
      onPermissionReactionClear: () => {
        // Replace permission reaction with processing reaction
        const progressMsgId = renderer.messageId;
        if (progressMsgId) {
          adapter.addReaction(msg.chatId, progressMsgId, reactions.processing).catch(() => {});
        }
      },
      onProgressStalled: () => {
        // Add ⏳ reaction on the bot's progress message
        const progressMsgId = renderer.messageId;
        if (progressMsgId && !stalledReactionAdded) {
          stalledReactionAdded = true;
          adapter.addReaction(msg.chatId, progressMsgId, reactions.stalled).catch(() => {});
        }
      },
      onProgressResumed: () => {
        // Remove ⏳ reaction when progress resumes
        const progressMsgId = renderer.messageId;
        if (progressMsgId && stalledReactionAdded) {
          stalledReactionAdded = false;
          // Replace stalled reaction with processing reaction
          adapter.addReaction(msg.chatId, progressMsgId, reactions.processing).catch(() => {});
        }
      },
      flushCallback: (content, isEdit, buttons, state) => presenter.flush(content, isEdit, buttons, state),
    });

    let askQuestionApproved = false;
    const sdkPermissionHandler = async (toolName: string, toolInput: Record<string, unknown>, _promptSentence: string, signal?: AbortSignal) => {
          // Check perm mode dynamically (so /perm off mid-query takes effect)
          const permMode = this.options.state.getPermMode(msg.channelType, msg.chatId);
          if (permMode === 'off') {
            return 'allow' as const;
          }

          if (this.options.permissions.isToolAllowed(binding.sessionId, toolName, toolInput)) {
            console.log(`[bridge] Auto-allowed ${toolName} via session whitelist`);
            return 'allow' as const;
          }

          if (askQuestionApproved) {
            askQuestionApproved = false;
            console.log(`[bridge] Auto-allowed ${toolName} after AskUserQuestion approval`);
            return 'allow' as const;
          }

          const permId = `sdk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const chatKey = this.options.state.stateKey(msg.channelType, msg.chatId);
          this.options.permissions.setPendingSdkPerm(chatKey, permId);
          console.log(`[bridge] Permission request: ${toolName} (${permId}) for ${chatKey}`);

          const abortCleanup = () => {
            console.log(`[bridge] Permission cancelled by SDK: ${toolName} (${permId})`);
            this.options.permissions.getGateway().resolve(permId, 'deny', 'Cancelled by SDK');
            this.options.permissions.clearPendingSdkPerm(chatKey);
            this.options.permissions.notePermissionResolved(chatKey, binding.sessionId, toolName, 'cancelled', permId);
            renderer.onPermissionResolved(permId);
          };
          if (signal?.aborted) {
            abortCleanup();
            return 'deny' as const;
          }
          signal?.addEventListener('abort', abortCleanup, { once: true });

          const inputStr = getToolCommand(toolName, toolInput) || JSON.stringify(toolInput, null, 2);
          this.options.permissions.notePermissionPending(chatKey, permId, binding.sessionId, toolName, inputStr);
          const buttons: Array<{ label: string; callbackData: string; style: string }> = [
            { label: '✅ Allow', callbackData: `perm:allow:${permId}`, style: 'primary' },
            { label: '📌 Always in Session', callbackData: `perm:allow_session:${permId}`, style: 'default' },
            { label: '❌ Deny', callbackData: `perm:deny:${permId}`, style: 'danger' },
          ];
          renderer.onPermissionNeeded(toolName, inputStr, permId, buttons);

          const result = await this.options.permissions.getGateway().waitFor(permId, {
            timeoutMs: 5 * 60 * 1000,
            onTimeout: () => {
              this.options.permissions.clearPendingSdkPerm(chatKey);
              this.options.permissions.clearPendingPermissionSnapshot(chatKey, permId);
              console.warn(`[bridge] Permission timeout: ${toolName} (${permId})`);
            },
          });
          signal?.removeEventListener('abort', abortCleanup);
          renderer.onPermissionResolved(permId);

          this.options.permissions.clearPendingSdkPerm(chatKey);
          if (result.behavior === 'allow_always') {
            this.options.permissions.rememberSessionAllowance(binding.sessionId, toolName, toolInput);
          }
          this.options.permissions.notePermissionResolved(
            chatKey,
            binding.sessionId,
            toolName,
            result.behavior === 'deny' && signal?.aborted ? 'cancelled' : result.behavior,
            permId,
          );
          console.log(`[bridge] Permission resolved: ${toolName} (${permId}) → ${result.behavior}`);
          return result.behavior as 'allow' | 'allow_always' | 'deny';
        };

    const sdkAskQuestionHandler = async (
      questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean }>,
      signal?: AbortSignal,
    ): Promise<Record<string, string>> => {
      if (!questions.length) return {};
      const answers: Record<string, string> = {};
      const interactionState = this.options.sdkEngine.getInteractionState();

      for (const q of questions) {
        const permId = `askq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const isMulti = q.multiSelect;
        interactionState.beginSdkQuestion(permId, [q], msg.chatId);
        if (isMulti) {
          this.options.permissions.storeQuestionData(permId, [q]);
        }

        const abortCleanup = () => {
          this.options.permissions.getGateway().resolve(permId, 'deny', 'Cancelled');
          interactionState.cleanupSdkQuestion(permId);
          this.options.permissions.cleanupQuestion(permId);
        };
        if (signal?.aborted) {
          abortCleanup();
          throw new Error('Cancelled');
        }
        signal?.addEventListener('abort', abortCleanup, { once: true });
        const waitPromise = this.options.permissions.getGateway().waitFor(permId, {
          timeoutMs: 5 * 60 * 1000,
          onTimeout: () => {
            interactionState.cleanupSdkQuestion(permId);
            this.options.permissions.cleanupQuestion(permId);
          },
        });

        const outMsg = adapter.format({
          type: 'question',
          chatId: msg.chatId,
          data: {
            question: q.question,
            header: q.header,
            options: q.options,
            multiSelect: isMulti,
            permId,
            sessionId: 'sdk',
          },
        });
        const sendResult = await adapter.send(outMsg);
        this.options.permissions.trackPermissionMessage(sendResult.messageId, permId, binding.sessionId, msg.channelType);

        const result = await waitPromise;
        signal?.removeEventListener('abort', abortCleanup);

        if (result.behavior === 'deny') {
          interactionState.cleanupSdkQuestion(permId);
          this.options.permissions.cleanupQuestion(permId);
          adapter.editCardResolution(msg.chatId, sendResult.messageId, {
            resolution: 'skipped', label: '⏭ Skipped',
          }).catch(() => {});
          throw new Error('User skipped question');
        }

        const { textAnswer, optionIndex } = interactionState.consumeSdkQuestionAnswer(permId);
        interactionState.cleanupSdkQuestion(permId);
        this.options.permissions.cleanupQuestion(permId);

        if (textAnswer !== undefined) {
          adapter.editCardResolution(msg.chatId, sendResult.messageId, {
            resolution: 'answered', label: `✅ Answer: ${truncate(textAnswer, 50)}`,
          }).catch(() => {});
          answers[q.question] = textAnswer;
          continue;
        }

        const selected = optionIndex !== undefined ? q.options[optionIndex] : undefined;
        const answerLabel = selected?.label ?? '';

        if (!selected) {
          adapter.editCardResolution(msg.chatId, sendResult.messageId, {
            resolution: 'answered', label: '✅ Answered',
          }).catch(() => {});
        }

        answers[q.question] = answerLabel;
      }

      askQuestionApproved = true;
      return answers;
    };

    try {
      // Get or create a LiveSession for this chat
      const workdir = binding.cwd || this.options.defaultWorkdir;
      const settingSources = binding.claudeSettingSources ?? this.options.defaultClaudeSettingSources;
      const chatKey = this.options.state.stateKey(msg.channelType, msg.chatId);
      const sessionKey = `${msg.channelType}:${msg.chatId}:${workdir}`;
      let liveSession: LiveSession | undefined;
      let streamResult: import('../providers/base.js').StreamChatResult | undefined;

      try {
        liveSession = this.options.sdkEngine.getOrCreateSession(
          this.options.llm,
          msg.channelType,
          msg.chatId,
          workdir,
          {
            sessionId: binding.sdkSessionId,
            settingSources,
          },
        );
      } catch (err) {
        console.warn(`[bridge] Failed to create LiveSession, falling back to streamChat: ${err}`);
      }

      if (liveSession) {
        // Use LiveSession: startTurn with per-turn handlers
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
        // When using LiveSession, streamResult bypasses streamChat;
        // permission/question handlers are set per-turn on the session.
        // When no LiveSession, fall back to streamChat with these handlers.
        streamResult,
        sdkPermissionHandler: streamResult ? undefined : sdkPermissionHandler,
        sdkAskQuestionHandler: streamResult ? undefined : sdkAskQuestionHandler,
        onControls: (ctrl) => {
          this.options.sdkEngine.setControlsForChat(chatKey, ctrl);
        },
        onSdkSessionId: async (id) => {
          binding.sdkSessionId = id;
          await this.options.store.saveBinding(binding);
        },
        onTextDelta: (delta) => renderer.onTextDelta(delta),
        onThinkingDelta: (delta) => renderer.onThinkingDelta(delta),
        onToolStart: (event) => {
          renderer.onToolStart(event.name, event.input, event.id);
        },
        onToolResult: (event) => {
          renderer.onToolResult(event.toolUseId, event.content, event.isError);
          renderer.onToolComplete(event.toolUseId);
        },
        onAgentStart: (data) => {
          if (DEBUG_EVENTS) {
            console.log(`[bridge] agent_start: ${data.description}`);
          }
          renderer.onToolStart('Agent', { description: data.description, prompt: '' });
        },
        onAgentProgress: (data) => {
          if (DEBUG_EVENTS) {
            console.log(`[bridge] agent_progress: ${data.description}${data.lastTool ? ` (lastTool=${data.lastTool})` : ''}`);
          }
          if (data.usage?.durationMs) {
            renderer.onToolProgress({ toolName: 'Agent', elapsed: data.usage.durationMs });
          }
        },
        onAgentComplete: () => {
          renderer.onToolComplete('agent-complete');
        },
        onToolProgress: (data) => {
          renderer.onToolProgress(data);
        },
        onStatus: (data) => {
          renderer.setModel(data.model);
        },
        onRateLimit: (data) => {
          if (data.status === 'rejected') {
            renderer.onTextDelta('\n⚠️ Rate limited. Retrying...\n');
          } else if (data.status === 'allowed_warning' && data.utilization) {
            renderer.onTextDelta(`\n⚠️ Rate limit: ${Math.round(data.utilization * 100)}% used\n`);
          }
        },
        onTodoUpdate: (todos) => {
          renderer.onTodoUpdate(todos);
        },
        onQueryResult: async (event) => {
          if (event.permissionDenials?.length) {
            console.warn(`[bridge] Permission denials: ${event.permissionDenials.map(denial => denial.toolName).join(', ')}`);
          }
          const usage = {
            input_tokens: event.usage.inputTokens,
            output_tokens: event.usage.outputTokens,
            cost_usd: event.usage.costUsd,
          };
          costTracker.finish(usage);
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
          // Check for session expiry / stale thinking signature — clear sdkSessionId and kill LiveSession
          if (err.includes('No conversation found') || err.includes('session ID') || err.includes('Invalid') && err.includes('signature')) {
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

      // Track progress bubble → session for multi-session steering
      if (renderer.messageId) {
        this.options.sdkEngine.setActiveMessageId(chatKey, renderer.messageId, sessionKey);
      }

      adapter.addReaction(reactionChatId, msg.messageId, reactions.done).catch(() => {});
      // Also add reaction to the bot's progress message for visibility
      if (renderer.messageId) {
        adapter.addReaction(msg.chatId, renderer.messageId, reactions.done).catch(() => {});
      }
    } catch (err) {
      adapter.addReaction(reactionChatId, msg.messageId, reactions.error).catch(() => {});
      // Also add error reaction to the bot's progress message
      if (renderer.messageId) {
        adapter.addReaction(msg.chatId, renderer.messageId, reactions.error).catch(() => {});
      }
      throw err;
    } finally {
      clearInterval(typingInterval);
      renderer.dispose();
      await presenter.dispose();
      this.options.sdkEngine.setControlsForChat(this.options.state.stateKey(msg.channelType, msg.chatId), undefined);
    }

    return true;
  }
}
