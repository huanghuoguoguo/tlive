import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import type { PermissionCoordinator } from '../coordinators/permission.js';
import type { SDKEngine } from '../sdk/engine.js';
import type { SessionStateManager } from '../state/session-state.js';
import { t, matchesLocalizedInput } from '../../i18n/index.js';
import { conversationScopeId } from '../../channels/conversation-context.js';
import { withInboundReplyContext } from '../../channels/reply-context.js';

interface TextDispatcherOptions {
  permissions: PermissionCoordinator;
  sdkEngine: SDKEngine;
  state: SessionStateManager;
}

type PendingSdkQuestion = {
  permId: string;
};

type PendingDeferredTool = {
  permId: string;
  toolName: string;
};

/**
 * Handles text-driven control flows before a message reaches the main provider turn:
 * - plain-text permission approvals
 * - AskUserQuestion numeric/text answers
 * - Deferred tool input (EnterPlanMode, EnterWorktree, etc.)
 */
export class TextDispatcher {
  constructor(private options: TextDispatcherOptions) {}

  hasPendingSdkQuestion(msg: InboundMessage): boolean {
    return this.findPendingSdkQuestion(conversationScopeId(msg)) !== null;
  }

  hasPendingDeferredTool(msg: InboundMessage): boolean {
    return this.findPendingDeferredTool(conversationScopeId(msg)) !== null;
  }

  async handle(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    if (msg.text && await this.handlePermissionText(adapter, msg)) {
      return true;
    }

    if (msg.text && await this.handleDeferredToolInput(adapter, msg)) {
      return true;
    }

    if (msg.text && await this.handleQuestionReply(msg)) {
      return true;
    }

    return false;
  }

  private findPendingSdkQuestion(chatId: string): PendingSdkQuestion | null {
    return this.options.sdkEngine
      .getInteractionState()
      .findPendingSdkQuestion(chatId, this.options.permissions.getGateway());
  }

  private findPendingDeferredTool(chatId: string): PendingDeferredTool | null {
    return this.options.sdkEngine
      .getInteractionState()
      .findPendingDeferredTool(chatId, this.options.permissions.getGateway());
  }

  private async handleDeferredToolInput(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    const pendingDeferred = this.findPendingDeferredTool(conversationScopeId(msg));
    if (!pendingDeferred) {
      return false;
    }

    const locale = adapter.getLocale();
    const trimmed = msg.text.trim();
    if (matchesLocalizedInput(trimmed, 'input.skip')) {
      this.options.permissions.getGateway().resolve(pendingDeferred.permId, 'deny', 'Skipped');
      this.options.sdkEngine.getInteractionState().cleanupDeferredTool(pendingDeferred.permId);
      await adapter.send(withInboundReplyContext({ chatId: msg.chatId, text: t(locale, 'input.skipped') }, msg));
      return true;
    }

    // Store user input and resolve permission
    this.options.sdkEngine.getInteractionState().setDeferredToolInput(pendingDeferred.permId, trimmed);
    this.options.permissions.getGateway().resolve(pendingDeferred.permId, 'allow');
    await adapter.send(withInboundReplyContext({
      chatId: msg.chatId,
      text: `${t(locale, 'input.submitted')} ${trimmed.slice(0, 50)}${trimmed.length > 50 ? '...' : ''}`,
    }, msg));
    return true;
  }

  private async handlePermissionText(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    const decision = this.options.permissions.parsePermissionText(msg.text);
    if (!decision) {
      return false;
    }

    const chatKey = this.options.state.stateKey(msg.channelType, conversationScopeId(msg));
    if (this.options.permissions.tryResolveByText(chatKey, decision)) {
      const emoji = adapter.getPermissionDecisionReaction(decision);
      adapter.addReaction(msg.chatId, msg.messageId, emoji).catch(() => {});
      return true;
    }

    return false;
  }

  private async handleQuestionReply(msg: InboundMessage): Promise<boolean> {
    const trimmed = msg.text.trim();
    const pendingSdkQuestion = this.findPendingSdkQuestion(conversationScopeId(msg));

    if (!pendingSdkQuestion) {
      return false;
    }

    const optionIndex = this.getValidOptionIndex(trimmed, pendingSdkQuestion);
    if (optionIndex !== null) {
      this.options.sdkEngine.getInteractionState().setSdkQuestionOptionAnswer(
        pendingSdkQuestion.permId,
        optionIndex,
      );
      this.options.permissions.getGateway().resolve(pendingSdkQuestion.permId, 'allow');
      return true;
    }

    this.options.sdkEngine.getInteractionState().setSdkQuestionTextAnswer(
      pendingSdkQuestion.permId,
      trimmed,
    );
    this.options.permissions.getGateway().resolve(pendingSdkQuestion.permId, 'allow');
    return true;
  }

  private getValidOptionIndex(
    trimmed: string,
    pendingSdkQuestion: PendingSdkQuestion,
  ): number | null {
    const numericMatch = trimmed.match(/^(\d+)$/);
    if (!numericMatch) {
      return null;
    }

    const index = parseInt(numericMatch[1], 10) - 1;
    if (index < 0) {
      return null;
    }

    const interactionState = this.options.sdkEngine.getInteractionState();
    const questionData = interactionState.getSdkQuestion(pendingSdkQuestion.permId);

    const optionsCount = questionData?.questions?.[0]?.options?.length ?? 0;
    return index < optionsCount ? index : null;
  }
}
