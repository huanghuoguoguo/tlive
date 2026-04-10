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
import type { BridgeStore } from '../store/interface.js';

interface QueryOrchestratorOptions {
  engine: ConversationEngine;
  router: ChannelRouter;
  state: SessionStateManager;
  permissions: PermissionCoordinator;
  sdkEngine: SDKEngine;
  store: BridgeStore;
  defaultWorkdir: string;
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
    if (expired) {
      await this.options.router.rebind(msg.channelType, msg.chatId, generateSessionId());
      this.options.state.clearThread(msg.channelType, msg.chatId);
      this.options.permissions.clearSessionWhitelist();
    }

    const binding = await this.options.router.resolve(msg.channelType, msg.chatId);
    const verboseLevel = this.options.state.getVerboseLevel(msg.channelType, msg.chatId);

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
      model: this.options.state.getModel(msg.channelType, msg.chatId),
      sessionId: binding.sdkSessionId,
      verboseLevel,
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
            todoItems: state.todoItems,
            thinkingText: state.thinkingText,
            toolLogs: state.toolLogs,
            actionButtons: buttons?.length
              ? buttons.map(button => ({ ...button, style: button.style as 'primary' | 'danger' | 'default' }))
              : undefined,
          };
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

          if (this.options.permissions.isToolAllowed(toolName, toolInput)) {
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
            renderer.onPermissionResolved(permId);
          };
          if (signal?.aborted) {
            abortCleanup();
            return 'deny' as const;
          }
          signal?.addEventListener('abort', abortCleanup, { once: true });

          const inputStr = getToolCommand(toolName, toolInput) || JSON.stringify(toolInput, null, 2);
          const buttons: Array<{ label: string; callbackData: string; style: string }> = [
            { label: '✅ Allow', callbackData: `perm:allow:${permId}`, style: 'primary' },
            { label: '❌ Deny', callbackData: `perm:deny:${permId}`, style: 'danger' },
          ];
          renderer.onPermissionNeeded(toolName, inputStr, permId, buttons);

          const result = await this.options.permissions.getGateway().waitFor(permId, {
            timeoutMs: 5 * 60 * 1000,
            onTimeout: () => {
              this.options.permissions.clearPendingSdkPerm(chatKey);
              console.warn(`[bridge] Permission timeout: ${toolName} (${permId})`);
            },
          });
          signal?.removeEventListener('abort', abortCleanup);
          renderer.onPermissionResolved(permId);

          this.options.permissions.clearPendingSdkPerm(chatKey);
          console.log(`[bridge] Permission resolved: ${toolName} (${permId}) → ${result.behavior}`);
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
      await this.options.engine.processMessage({
        sdkSessionId: binding.sdkSessionId,
        workingDirectory: binding.cwd || this.options.defaultWorkdir,
        text: msg.text,
        attachments: msg.attachments,
        sdkPermissionHandler,
        sdkAskQuestionHandler,
        effort: this.options.state.getEffort(msg.channelType, msg.chatId),
        model: this.options.state.getModel(msg.channelType, msg.chatId),
        onControls: (ctrl) => {
          const chatKey = this.options.state.stateKey(msg.channelType, msg.chatId);
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
          renderer.onToolStart('Agent', { description: data.description, prompt: '' });
        },
        onAgentProgress: (data) => {
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
          await renderer.onComplete();
        },
        onPromptSuggestion: (suggestion) => {
          if (verboseLevel === 0) return;
          const truncated = truncate(suggestion, 60);
          adapter.send({
            chatId: msg.chatId,
            text: `💡 ${truncated}`,
            buttons: [{ label: `💡 ${truncated}`, callbackData: `suggest:${suggestion.slice(0, 200)}`, style: 'default' as const }],
          }).catch(() => {});
        },
        onError: async (err) => {
          // Check for session expiry / stale thinking signature — clear sdkSessionId so next query starts fresh
          if (err.includes('No conversation found') || err.includes('session ID') || err.includes('Invalid') && err.includes('signature')) {
            console.log(`[bridge] Session expired or stale, clearing sdkSessionId for ${msg.channelType}:${msg.chatId}`);
            binding.sdkSessionId = undefined;
            await this.options.store.saveBinding(binding);
          }
          await renderer.onError(err);
        },
      });

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
      this.options.sdkEngine.setControlsForChat(this.options.state.stateKey(msg.channelType, msg.chatId), undefined);
      // if (feishuSession) { feishuSession.close().catch(() => {}); }
    }

    return true;
  }
}
