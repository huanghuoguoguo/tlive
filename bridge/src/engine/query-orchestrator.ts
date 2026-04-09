import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage, OutboundMessage } from '../channels/types.js';
import type { ProgressData } from '../formatting/message-types.js';
import { markdownToTelegram } from '../markdown/index.js';
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
    let permissionReminderMsgId: string | undefined;
    let permissionReminderTool: string | undefined;
    let permissionReminderInput: string | undefined;
    let progressReminderMsgId: string | undefined;
    const renderer = new MessageRenderer({
      platformLimit: PLATFORM_LIMITS[adapter.channelType as ChannelType] ?? 4096,
      throttleMs: 300,
      cwd: binding.cwd || this.options.defaultWorkdir,
      model: this.options.state.getModel(msg.channelType, msg.chatId),
      sessionId: binding.sdkSessionId,
      verboseLevel,
      onPermissionTimeout: async (toolName, input, buttons) => {
        permissionReminderTool = toolName;
        permissionReminderInput = input;
        const text = `⚠️ Permission pending — ${toolName}: ${permissionReminderInput}`;
        const outMsg: OutboundMessage = adapter.channelType === CHANNEL_TYPES.TELEGRAM
          ? { chatId: msg.chatId, html: markdownToTelegram(text) }
          : { chatId: msg.chatId, text };
        outMsg.buttons = buttons.map(button => ({ ...button, style: button.style as 'primary' | 'danger' | 'default' }));
        try {
          const result = await adapter.send(outMsg);
          permissionReminderMsgId = result.messageId;
        } catch {
          // Non-fatal.
        }
      },
      onProgressTimeout: async (summary) => {
        // Progress reminder is a Feishu-only UX feature
        if (adapter.channelType !== CHANNEL_TYPES.FEISHU) return;
        const progressData: ProgressData = {
          phase: 'executing',
          renderedText: '',
          taskSummary: summary.taskSummary,
          elapsedSeconds: summary.elapsedSeconds,
          totalTools: 0,
          todoItems: [],
          currentTool: summary.currentTool ? {
            name: summary.currentTool.name,
            input: summary.currentTool.input,
            elapsed: 0,
          } : null,
          actionButtons: [
            { label: '⏹ 停止执行', callbackData: 'cmd:stop', style: 'danger' as const },
          ],
        };
        try {
          const result = await adapter.send(adapter.format({
            type: 'progress',
            chatId: msg.chatId,
            data: progressData,
          }));
          progressReminderMsgId = result.messageId;
        } catch {
          // Non-fatal.
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
        if (adapter.channelType === CHANNEL_TYPES.TELEGRAM) {
          outMsg = { chatId: msg.chatId, html: markdownToTelegram(content) };
          if (buttons?.length) {
            outMsg.buttons = buttons.map(button => ({ ...button, style: button.style as 'primary' | 'danger' | 'default' }));
          }
        } else if (state) {
          // Use semantic formatting for progress cards
          const actionButtons = buttons?.length
            ? buttons.map(button => ({ ...button, style: button.style as 'primary' | 'danger' | 'default' }))
            : state.phase === 'completed'
              ? [
                  { label: '🕘 最近会话', callbackData: 'cmd:sessions --all', style: 'primary' as const, row: 0 },
                  { label: '🆕 新会话', callbackData: 'cmd:new', style: 'default' as const, row: 0 },
                  { label: '❓ 帮助', callbackData: 'cmd:help', style: 'default' as const, row: 1 },
                ]
              : state.phase === 'failed'
                ? [
                    { label: '🕘 最近会话', callbackData: 'cmd:sessions --all', style: 'primary' as const, row: 0 },
                    { label: '🆕 新会话', callbackData: 'cmd:new', style: 'default' as const, row: 0 },
                    { label: '❓ 帮助', callbackData: 'cmd:help', style: 'default' as const, row: 1 },
                  ]
                : [
                    { label: '⏹ 停止执行', callbackData: 'cmd:stop', style: 'danger' as const, row: 0 },
                    { label: '❓ 帮助', callbackData: 'cmd:help', style: 'default' as const, row: 1 },
                  ];
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
            actionButtons,
          };
          outMsg = adapter.format({ type: 'progress', chatId: msg.chatId, data: progressData });
        } else {
          outMsg = { chatId: msg.chatId, text: content };
          if (buttons?.length) {
            outMsg.buttons = buttons.map(button => ({ ...button, style: button.style as 'primary' | 'danger' | 'default' }));
          }
        }

        if (!isEdit) {
          const result = await adapter.send(outMsg);
          clearInterval(typingInterval);
          return result.messageId;
        }

        const limit = PLATFORM_LIMITS[adapter.channelType as ChannelType] ?? 4096;
        if (content.length > limit) {
          const chunks = chunkByParagraph(content, limit);
          const firstOutMsg: OutboundMessage = adapter.channelType === CHANNEL_TYPES.TELEGRAM
            ? { chatId: msg.chatId, html: markdownToTelegram(chunks[0]) }
            : { chatId: msg.chatId, text: chunks[0] };
          await adapter.editMessage(msg.chatId, renderer.messageId!, firstOutMsg);
          for (let i = 1; i < chunks.length; i++) {
            const overflowMsg: OutboundMessage = adapter.channelType === CHANNEL_TYPES.TELEGRAM
              ? { chatId: msg.chatId, html: markdownToTelegram(chunks[i]) }
              : { chatId: msg.chatId, text: chunks[i] };
            await adapter.send(overflowMsg);
          }
        } else {
          await adapter.editMessage(msg.chatId, renderer.messageId!, outMsg);
        }
      },
    });

    let askQuestionApproved = false;
    const permMode = this.options.state.getPermMode(msg.channelType, msg.chatId);
    const sdkPermissionHandler = permMode === 'on'
      ? async (toolName: string, toolInput: Record<string, unknown>, _promptSentence: string, signal?: AbortSignal) => {
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

          if (permissionReminderMsgId) {
            const icon = result.behavior === 'deny' ? '❌' : '✅';
            const label = `${permissionReminderTool}: ${permissionReminderInput} ${icon}`;
            adapter.editMessage(msg.chatId, permissionReminderMsgId, {
              chatId: msg.chatId,
              text: label,
            }).catch(() => {});
            permissionReminderMsgId = undefined;
          }

          this.options.permissions.clearPendingSdkPerm(chatKey);
          console.log(`[bridge] Permission resolved: ${toolName} (${permId}) → ${result.behavior}`);
          return result.behavior as 'allow' | 'allow_always' | 'deny';
        }
      : undefined;

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

      // Use semantic formatting for question cards
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
        const skippedMsg = adapter.format({
          type: 'cardResolution',
          chatId: msg.chatId,
          data: { resolution: 'skipped', label: '⏭ Skipped' },
        });
        adapter.editMessage(msg.chatId, sendResult.messageId, skippedMsg).catch(() => {});
        throw new Error('User skipped question');
      }

      askQuestionApproved = true;

      const { sdkQuestionTextAnswers, sdkQuestionAnswers } = this.options.sdkEngine.getQuestionState();
      const textAnswer = sdkQuestionTextAnswers.get(permId);
      sdkQuestionTextAnswers.delete(permId);
      sdkQuestionData.delete(permId);

      if (textAnswer !== undefined) {
        const answeredMsg = adapter.format({
          type: 'cardResolution',
          chatId: msg.chatId,
          data: { resolution: 'answered', label: `✅ Answer: ${truncate(textAnswer, 50)}` },
        });
        adapter.editMessage(msg.chatId, sendResult.messageId, answeredMsg).catch(() => {});
        return { [q.question]: textAnswer };
      }

      const optionIndex = sdkQuestionAnswers.get(permId);
      sdkQuestionAnswers.delete(permId);
      const selected = optionIndex !== undefined ? q.options[optionIndex] : undefined;
      const answerLabel = selected?.label ?? '';

      if (!selected) {
        const answeredMsg = adapter.format({
          type: 'cardResolution',
          chatId: msg.chatId,
          data: { resolution: 'answered', label: '✅ Answered' },
        });
        adapter.editMessage(msg.chatId, sendResult.messageId, answeredMsg).catch(() => {});
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
        onToolStart: (event) => {
          renderer.onToolStart(event.name, event.input);
        },
        onToolResult: (event) => {
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
          // Delete progress reminder message if exists
          if (progressReminderMsgId) {
            adapter.deleteMessage(msg.chatId, progressReminderMsgId).catch(() => {});
            progressReminderMsgId = undefined;
          }
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
          await renderer.onError(err);
        },
      });

      adapter.addReaction(reactionChatId, msg.messageId, reactions.done).catch(() => {});
    } catch (err) {
      adapter.addReaction(reactionChatId, msg.messageId, reactions.error).catch(() => {});
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
