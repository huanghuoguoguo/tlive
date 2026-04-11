import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage, OutboundMessage } from '../channels/types.js';
import type { ProgressData } from '../formatting/message-types.js';
import { downgradeHeadings } from '../markdown/feishu.js';
import { MessageRenderer } from './message-renderer.js';
import { getToolCommand } from './tool-registry.js';
import { CostTracker } from './cost-tracker.js';
import { chunkByParagraph } from '../delivery/delivery.js';
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
import { Logger, type LogContext } from '../logger.js';
const DEBUG_EVENTS = process.env.TL_DEBUG_EVENTS === '1';
import type { LLMProvider, LiveSession } from '../providers/base.js';

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

  private buildTaskSummary(state: {
    responseText: string;
    renderedText: string;
    toolLogs: Array<{ name: string; input: string }>;
    permissionRequests: number;
    errorMessage?: string;
  }): import('../formatting/message-types.js').TaskSummaryData {
    const summarySource = (state.responseText || state.renderedText || '').trim();
    const summary = truncate(summarySource || '任务已完成', 280);
    const changedFileKeys = new Set(
      state.toolLogs
        .filter(log => ['Edit', 'Write', 'MultiEdit'].includes(log.name) && log.input.trim())
        .map(log => log.input.trim()),
    );
    const hasError = !!state.errorMessage;
    const nextStep = hasError
      ? '查看失败原因后继续追问，或重新发起一个更小的修改任务。'
      : changedFileKeys.size > 0
        ? '如果结果符合预期，可以继续追问、测试变更，或切回最近会话继续处理。'
        : '可以继续追问细节，或切回最近会话处理下一步任务。';

    return {
      summary,
      changedFiles: changedFileKeys.size,
      permissionRequests: state.permissionRequests,
      hasError,
      nextStep,
    };
  }

  private shouldSplitFeishuCompletion(state: {
    totalTools: number;
    thinkingText: string;
    timeline: Array<{ kind: 'thinking' | 'text' | 'tool' }>;
    responseText: string;
  }): boolean {
    const thinkingCount = state.timeline.filter(entry => entry.kind === 'thinking').length;
    const toolCount = state.timeline.filter(entry => entry.kind === 'tool').length;
    const hasLongTrace = state.thinkingText.trim().length > 80 || state.timeline.length >= 4;
    const hasMeaningfulTooling = toolCount >= 2 || (toolCount >= 1 && thinkingCount >= 1);
    const hasLongAnswer = state.responseText.trim().length > 200;
    return hasMeaningfulTooling || hasLongTrace || (toolCount >= 1 && hasLongAnswer);
  }

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
      });
      this.options.state.clearThread(msg.channelType, msg.chatId);
    }

    const binding = await this.options.router.resolve(msg.channelType, msg.chatId);
    ctx.sessionId = binding.sessionId;
    console.log(`[query] ${ctx.requestId} START session=${binding.sessionId.slice(-4)} cwd=${shortPath(binding.cwd || this.options.defaultWorkdir)}`);

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

    let feishuSession: import('../channels/feishu-streaming.js').FeishuStreamingSession | null = null;
    let stalledReactionAdded = false;
    const renderer = new MessageRenderer({
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
      flushCallback: async (content, isEdit, buttons, state) => {
        if (
          adapter.channelType === 'qqbot'
          && state
          && (state.phase === 'starting' || state.phase === 'executing')
        ) {
          return;
        }

        if (feishuSession && !buttons?.length) {
          if (!isEdit) {
            try {
              const messageId = await feishuSession.start(downgradeHeadings(content));
              clearInterval(typingInterval);
              return messageId;
            } catch {
              feishuSession = null;
            }
          } else {
            feishuSession.update(downgradeHeadings(content)).catch(() => {});
            return;
          }
        }

        let outMsg: OutboundMessage;
        if (state) {
          const progressData: ProgressData = {
            phase: state.phase,
            renderedText: content,
            taskSummary: msg.text || '继续当前任务',
            elapsedSeconds: state.elapsedSeconds,
            totalTools: state.totalTools,
            toolSummary: state.toolSummary,
            footerLine: state.footerLine,
            currentTool: state.currentTool,
            permission: state.permission,
            permissionRequests: state.permissionRequests,
            todoItems: state.todoItems,
            thinkingText: state.thinkingText,
            toolLogs: state.toolLogs,
            timeline: state.timeline,
            isContinuation: state.isContinuation,
            actionButtons: buttons?.length
              ? buttons.map(button => ({ ...button, style: button.style as 'primary' | 'danger' | 'default' }))
              : undefined,
          };

          if (
            adapter.channelType === 'feishu'
            && state.phase === 'completed'
            && this.shouldSplitFeishuCompletion({
              totalTools: state.totalTools,
              thinkingText: state.thinkingText,
              timeline: state.timeline,
              responseText: state.responseText,
            })
          ) {
            const traceMsg = adapter.format({
              type: 'progress',
              chatId: msg.chatId,
              data: {
                ...progressData,
                renderedText: '',
                footerLine: undefined,
                completedTraceOnly: true,
              },
            });
            if (isEdit) {
              await adapter.editMessage(msg.chatId, renderer.messageId!, traceMsg);
            } else {
              const traceResult = await adapter.send(traceMsg);
              clearInterval(typingInterval);
              void traceResult;
            }

            const summaryMsg = adapter.format({
              type: 'taskSummary',
              chatId: msg.chatId,
              data: this.buildTaskSummary({
                responseText: state.responseText,
                renderedText: content,
                toolLogs: state.toolLogs,
                permissionRequests: state.permissionRequests,
                errorMessage: state.errorMessage,
              }),
            });
            await adapter.send(summaryMsg);
            return;
          }

          outMsg = adapter.format({ type: 'progress', chatId: msg.chatId, data: progressData });
        } else {
          const castButtons = buttons?.length
            ? buttons.map(button => ({ ...button, style: button.style as 'primary' | 'danger' | 'default' }))
            : undefined;
          outMsg = adapter.formatContent(msg.chatId, content, castButtons);
        }

        if (!isEdit) {
          const result = await adapter.send(outMsg);
          clearInterval(typingInterval);
          return result.messageId;
        }

        const limit = PLATFORM_LIMITS[adapter.channelType as ChannelType] ?? 4096;
        if (content.length > limit) {
          const chunks = chunkByParagraph(content, limit);
          await adapter.editMessage(msg.chatId, renderer.messageId!, adapter.formatContent(msg.chatId, chunks[0]));
          for (let i = 1; i < chunks.length; i++) {
            await adapter.send(adapter.formatContent(msg.chatId, chunks[i]));
          }
        } else {
          await adapter.editMessage(msg.chatId, renderer.messageId!, outMsg);
        }
      },
    });

    let askQuestionApproved = false;
    const sdkPermissionHandler = async (toolName: string, toolInput: Record<string, unknown>, _promptSentence: string, signal?: AbortSignal) => {
          // Check perm mode dynamically (so /perm off mid-query takes effect)
          const permMode = this.options.state.getPermMode(msg.channelType, msg.chatId);
          if (permMode === 'off') {
            return 'allow' as const;
          }

          if (this.options.permissions.isToolAllowed(binding.sessionId, toolName, toolInput)) {
            console.log(`[perm] ${ctx.requestId} AUTO_ALLOW ${toolName} (whitelist)`);
            return 'allow' as const;
          }

          if (askQuestionApproved) {
            askQuestionApproved = false;
            console.log(`[perm] ${ctx.requestId} AUTO_ALLOW ${toolName} (AskUserQuestion approved)`);
            return 'allow' as const;
          }

          const permId = `sdk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const chatKey = this.options.state.stateKey(msg.channelType, msg.chatId);
          this.options.permissions.setPendingSdkPerm(chatKey, permId);
          console.log(`[perm] ${ctx.requestId} REQUEST ${toolName} permId=${permId.slice(-6)}`);

          const abortCleanup = () => {
            console.log(`[perm] ${ctx.requestId} CANCEL ${toolName} permId=${permId.slice(-6)} (SDK abort)`);
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
            { label: '❌ Deny', callbackData: `perm:deny:${permId}`, style: 'danger' },
          ];
          renderer.onPermissionNeeded(toolName, inputStr, permId, buttons);

          const result = await this.options.permissions.getGateway().waitFor(permId, {
            timeoutMs: 5 * 60 * 1000,
            onTimeout: () => {
              this.options.permissions.clearPendingSdkPerm(chatKey);
              this.options.permissions.clearPendingPermissionSnapshot(chatKey, permId);
              console.warn(`[perm] ${ctx.requestId} TIMEOUT ${toolName} permId=${permId.slice(-6)}`);
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
          console.log(`[perm] ${ctx.requestId} RESOLVED ${toolName} permId=${permId.slice(-6)} → ${result.behavior}`);
          return result.behavior as 'allow' | 'allow_always' | 'deny';
        };

    const sdkAskQuestionHandler = async (
      questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean }>,
      signal?: AbortSignal,
    ): Promise<Record<string, string>> => {
      if (!questions.length) return {};
      const q = questions[0];
      const permId = `askq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const isMulti = q.multiSelect;

      const { sdkQuestionData } = this.options.sdkEngine.getQuestionState();
      sdkQuestionData.set(permId, { questions, chatId: msg.chatId });
      if (isMulti) {
        this.options.permissions.storeQuestionData(permId, questions);
      }

      const abortCleanup = () => {
        this.options.permissions.getGateway().resolve(permId, 'deny', 'Cancelled');
        sdkQuestionData.delete(permId);
      };
      if (signal?.aborted) {
        abortCleanup();
        throw new Error('Cancelled');
      }
      signal?.addEventListener('abort', abortCleanup, { once: true });
      const waitPromise = this.options.permissions.getGateway().waitFor(permId, {
        timeoutMs: 5 * 60 * 1000,
        onTimeout: () => {
          sdkQuestionData.delete(permId);
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
        sdkQuestionData.delete(permId);
        adapter.editCardResolution(msg.chatId, sendResult.messageId, {
          resolution: 'skipped', label: '⏭ Skipped',
        }).catch(() => {});
        throw new Error('User skipped question');
      }

      askQuestionApproved = true;

      const { sdkQuestionTextAnswers, sdkQuestionAnswers } = this.options.sdkEngine.getQuestionState();
      const textAnswer = sdkQuestionTextAnswers.get(permId);
      sdkQuestionTextAnswers.delete(permId);
      sdkQuestionData.delete(permId);

      if (textAnswer !== undefined) {
        adapter.editCardResolution(msg.chatId, sendResult.messageId, {
          resolution: 'answered', label: `✅ Answer: ${truncate(textAnswer, 50)}`,
        }).catch(() => {});
        return { [q.question]: textAnswer };
      }

      const optionIndex = sdkQuestionAnswers.get(permId);
      sdkQuestionAnswers.delete(permId);
      const selected = optionIndex !== undefined ? q.options[optionIndex] : undefined;
      const answerLabel = selected?.label ?? '';

      if (!selected) {
        adapter.editCardResolution(msg.chatId, sendResult.messageId, {
          resolution: 'answered', label: '✅ Answered',
        }).catch(() => {});
      }

      return { [q.question]: answerLabel };
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
            console.warn(`[query] ${ctx.requestId} DENIALS ${event.permissionDenials.map(denial => denial.toolName).join(', ')}`);
          }
          const usage = {
            input_tokens: event.usage.inputTokens,
            output_tokens: event.usage.outputTokens,
            cost_usd: event.usage.costUsd,
          };
          costTracker.finish(usage);
          console.log(`[query] ${ctx.requestId} COMPLETE tokens=${event.usage.inputTokens}+${event.usage.outputTokens} cost=${event.usage.costUsd?.toFixed(4) || '?'}$`);
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
            console.log(`[query] ${ctx.requestId} SESSION_STALE clearing sdkSessionId`);
            binding.sdkSessionId = undefined;
            await this.options.store.saveBinding(binding);
            this.options.sdkEngine.closeSession(msg.channelType, msg.chatId);
          }
          console.error(`[query] ${ctx.requestId} ERROR ${err.slice(0, 200)}`);
          await renderer.onError(err);
        },
      });

      // Track progress bubble → session for multi-session steering
      if (renderer.messageId) {
        this.options.sdkEngine.setActiveMessageId(chatKey, renderer.messageId, sessionKey);
        console.log(`[query] ${ctx.requestId} SENT msgId=${renderer.messageId.slice(-8)}`);
      }

      adapter.addReaction(reactionChatId, msg.messageId, reactions.done).catch(() => {});
      // Also add reaction to the bot's progress message for visibility
      if (renderer.messageId) {
        adapter.addReaction(msg.chatId, renderer.messageId, reactions.done).catch(() => {});
      }
    } catch (err) {
      console.error(`[query] ${ctx.requestId} FATAL ${Logger.formatError(err)}`);
      adapter.addReaction(reactionChatId, msg.messageId, reactions.error).catch(() => {});
      // Also add error reaction to the bot's progress message
      if (renderer.messageId) {
        adapter.addReaction(msg.chatId, renderer.messageId, reactions.error).catch(() => {});
      }
      throw err;
    } finally {
      clearInterval(typingInterval);
      renderer.dispose();
      this.options.sdkEngine.setControlsForChat(this.options.state.stateKey(msg.channelType, msg.chatId), undefined);
      // if (feishuSession) { feishuSession.close().catch(() => {}); }
    }

    return true;
  }
}
