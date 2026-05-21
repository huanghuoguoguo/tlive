import type { InboundMessage } from '../../channels/types.js';
import { withInboundReplyContext } from '../../channels/reply-context.js';
import { conversationScopeId } from '../../channels/conversation-context.js';
import { truncate } from '../../core/string.js';
import type { AgentSettingSource } from '../../config.js';
import type { BridgeStore } from '../../store/interface.js';
import type { ConversationEngine } from '../../utils/conversation.js';
import { preparePromptWithFileAttachments } from '../../utils/conversation.js';
import type { StreamChatResult } from '../../providers/base.js';
import type { AgentProviderRegistry } from '../../providers/registry.js';
import { invalidateSessionCache } from '../../providers/session-scanner.js';
import type { SessionStateManager } from '../state/session-state.js';
import { SessionStaleError, isStaleSessionError } from '../state/session-stale-error.js';
import type { SDKEngine } from '../sdk/engine.js';
import { buildFileSendRoutePrompt } from '../automation/file-send-prompt.js';
import type { QueryContext } from './query-context.js';

const DEBUG_EVENTS = process.env.TL_DEBUG_EVENTS === '1';

export type QueryTurnOutcome = 'completed' | 'failed';

export interface QueryTurnRunnerOptions {
  engine: ConversationEngine;
  providers: AgentProviderRegistry;
  state: SessionStateManager;
  sdkEngine: SDKEngine;
  store: BridgeStore;
  defaultWorkdir: string;
  defaultAgentSettingSources: AgentSettingSource[];
  appendSystemPrompt?: string;
  onSdkSessionId?: (query: QueryContext, sdkSessionId: string) => void | Promise<void>;
}

/**
 * Runs one provider turn and maps provider events into renderer calls.
 *
 * QueryOrchestrator owns conversation resolution and retry policy; this class owns
 * provider/session execution for a single resolved turn.
 */
export class QueryTurnRunner {
  constructor(private readonly options: QueryTurnRunnerOptions) {}

  async run(query: QueryContext, fileDeliveryRouteToken?: string): Promise<QueryTurnOutcome> {
    const {
      msg,
      binding,
      sessionKey,
      renderer,
      costTracker,
      sdkPermissionHandler,
      sdkAskQuestionHandler,
      sdkDeferredToolHandler,
      ctx,
    } = query;
    const workdir = query.getWorkdir(this.options.defaultWorkdir);
    const settingSources = query.getSettingSources(this.options.defaultAgentSettingSources);
    const scopeId = conversationScopeId(msg);
    const chatKey = this.options.state.stateKey(msg.channelType, scopeId);
    const imageAttachments = msg.attachments?.filter((a) => a.type === 'image');
    const provider = this.options.providers.require(binding.provider);
    const promptText =
      preparePromptWithFileAttachments(msg.text, msg.attachments) +
      buildFileSendRoutePrompt(fileDeliveryRouteToken);

    let streamResult: StreamChatResult | undefined;
    let terminalEventSeen = false;
    let queryFailed = false;

    let liveSession: ReturnType<SDKEngine['getOrCreateSession']> | undefined;
    try {
      liveSession = this.options.sdkEngine.getOrCreateSession(provider, {
        channelType: msg.channelType,
        chatId: scopeId,
        bindingSessionId: binding.sessionId,
        workdir,
        options: {
          sessionId: binding.sdkSessionId,
          settingSources,
          appendSystemPrompt: this.options.appendSystemPrompt,
          setAsCurrent:
            sessionKey === this.options.sdkEngine.getActiveSessionKey?.(msg.channelType, scopeId),
        },
      });
    } catch (err) {
      console.warn(`[bridge] Failed to create LiveSession, falling back to streamChat: ${err}`);
    }

    if (liveSession) {
      streamResult = liveSession.startTurn(promptText, {
        onPermissionRequest: sdkPermissionHandler,
        onAskUserQuestion: sdkAskQuestionHandler,
        onDeferredTool: sdkDeferredToolHandler,
        attachments: imageAttachments,
      });
    }

    await this.options.engine.processMessage({
      provider,
      sdkSessionId: binding.sdkSessionId,
      workingDirectory: workdir,
      settingSources,
      text: promptText,
      attachments: imageAttachments,
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
        await this.options.onSdkSessionId?.(query, id);
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
        console.log(
          `[bridge] api_retry: attempt ${data.attempt}/${data.maxRetries} delay=${data.retryDelayMs}ms${data.error ? ` error=${data.error}` : ''}`,
        );
        renderer.onApiRetry(data);
      },
      onCompactBoundary: (data) => {
        console.log(
          `[bridge] compact_boundary: trigger=${data.trigger}${data.preTokens ? ` pre_tokens=${data.preTokens}` : ''}`,
        );
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
        terminalEventSeen = true;
        if (queryFailed) return;
        if (event.permissionDenials?.length) {
          console.warn(
            `[query] ${ctx.requestId} DENIALS ${event.permissionDenials.map((denial) => denial.toolName).join(', ')}`,
          );
        }
        costTracker.finish({
          input_tokens: event.usage.inputTokens,
          output_tokens: event.usage.outputTokens,
          cost_usd: event.usage.costUsd,
        });
        console.log(
          `[query] ${ctx.requestId} COMPLETE tokens=${event.usage.inputTokens}+${event.usage.outputTokens} cost=${event.usage.costUsd?.toFixed(4) || '?'}$`,
        );
        invalidateSessionCache();
        if (DEBUG_EVENTS) {
          const state = renderer.getDebugSnapshot();
          console.log(
            `[bridge] final timeline: thinking=${state.thinkingEntries} text=${state.textEntries} tool=${state.toolEntries}`,
          );
        }
        await renderer.onComplete();
      },
      onPromptSuggestion: (suggestion) => {
        this.sendPromptSuggestion(query.msg, suggestion, query);
      },
      onError: async (err) => {
        if (isStaleSessionError(err)) {
          console.log(`[query] ${ctx.requestId} SESSION_STALE detected`);
          throw new SessionStaleError(err);
        }
        terminalEventSeen = true;
        if (queryFailed) return;
        queryFailed = true;
        console.error(`[query] ${ctx.requestId} ERROR ${err.slice(0, 200)}`);
        invalidateSessionCache();
        if (DEBUG_EVENTS) {
          const state = renderer.getDebugSnapshot();
          console.log(
            `[bridge] error timeline: thinking=${state.thinkingEntries} text=${state.textEntries} tool=${state.toolEntries}`,
          );
        }
        await renderer.onError(err);
      },
    });

    if (!terminalEventSeen) {
      queryFailed = true;
      const err = `${provider.displayName} stream ended without a result event`;
      console.error(`[query] ${ctx.requestId} ERROR ${err}`);
      invalidateSessionCache();
      await renderer.onError(err);
    }

    return queryFailed ? 'failed' : 'completed';
  }

  private sendPromptSuggestion(msg: InboundMessage, suggestion: string, query: QueryContext): void {
    const truncated = truncate(suggestion, 60);
    query.adapter
      .send(
        withInboundReplyContext(
          {
            chatId: msg.chatId,
            text: `💡 ${truncated}`,
            buttons: [
              {
                label: `💡 ${truncated}`,
                callbackData: `suggest:${suggestion.slice(0, 200)}`,
                style: 'default' as const,
              },
            ],
          },
          msg,
        ),
      )
      .catch(() => {});
  }
}
