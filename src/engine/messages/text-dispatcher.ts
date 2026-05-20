import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import type { PermissionCoordinator } from '../coordinators/permission.js';
import type { SDKEngine } from '../sdk/engine.js';
import type { SessionStateManager } from '../state/session-state.js';
import { t, matchesLocalizedInput } from '../../i18n/index.js';
import { messageScopeId } from '../../core/key.js';
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

type HookQuestion = {
  hookId: string;
  sessionId: string;
  messageId: string;
};

/**
 * Handles text-driven control flows before a message reaches the main Claude turn:
 * - plain-text permission approvals
 * - AskUserQuestion numeric/text answers
 * - Deferred tool input (EnterPlanMode, EnterWorktree, etc.)
 */
export class TextDispatcher {
  constructor(private options: TextDispatcherOptions) {}

  hasPendingSdkQuestion(msg: InboundMessage): boolean {
    return this.findPendingSdkQuestion(messageScopeId(msg)) !== null;
  }

  hasPendingDeferredTool(msg: InboundMessage): boolean {
    return this.findPendingDeferredTool(messageScopeId(msg)) !== null;
  }

  async handle(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    if (msg.text && await this.handlePermissionText(adapter, msg)) {
      return true;
    }

    if (msg.text && await this.handleDeferredToolInput(adapter, msg)) {
      return true;
    }

    if (msg.text && await this.handleQuestionReply(adapter, msg)) {
      return true;
    }

    // Hook reply feature removed with Go Core
    if ((msg.text || msg.attachments?.length) && msg.replyToMessageId && this.options.permissions.isHookMessage(msg.replyToMessageId)) {
      await adapter.send(withInboundReplyContext({ chatId: msg.chatId, text: '⚠️ Hook reply feature no longer available' }, msg));
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
    const pendingDeferred = this.findPendingDeferredTool(messageScopeId(msg));
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

    const chatKey = this.options.state.stateKey(msg.channelType, messageScopeId(msg));
    if (this.options.permissions.tryResolveByText(chatKey, decision)) {
      const emoji = adapter.getPermissionDecisionReaction(decision);
      adapter.addReaction(msg.chatId, msg.messageId, emoji).catch(() => {});
      return true;
    }

    if (this.options.permissions.pendingPermissionCount() > 1 && !msg.replyToMessageId) {
      const hint = t(adapter.getLocale(), 'dispatcher.multiPermHint');
      await adapter.send(withInboundReplyContext({ chatId: msg.chatId, text: hint }, msg));
      return true;
    }

    const permEntry = this.options.permissions.findHookPermission(msg.replyToMessageId, adapter.channelType);
    if (!permEntry) {
      return false;
    }

    // Hook permission resolution simplified (Go Core removed)
    try {
      await this.options.permissions.resolveHookPermission(permEntry.permissionId, decision, adapter.channelType);
      const label = decision === 'deny'
        ? t(adapter.getLocale(), 'input.hookDenied')
        : decision === 'allow_always'
          ? t(adapter.getLocale(), 'input.hookAlwaysAllowed')
          : t(adapter.getLocale(), 'input.hookAllowed');
      await adapter.send(withInboundReplyContext({ chatId: msg.chatId, text: label }, msg));
    } catch (err) {
      await adapter.send(withInboundReplyContext({
        chatId: msg.chatId,
        text: `${t(adapter.getLocale(), 'input.hookFailed')} ${err}`,
      }, msg));
    }
    return true;
  }

  private async handleQuestionReply(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    const trimmed = msg.text.trim();
    const pendingHookQuestion = this.options.permissions.getLatestPendingQuestion(adapter.channelType);
    const pendingSdkQuestion = this.findPendingSdkQuestion(messageScopeId(msg));

    if (!pendingHookQuestion && !pendingSdkQuestion) {
      return false;
    }

    const optionIndex = this.getValidOptionIndex(trimmed, pendingHookQuestion, pendingSdkQuestion);
    if (optionIndex !== null) {
      if (pendingHookQuestion) {
        await this.options.permissions.resolveAskQuestion(
          pendingHookQuestion.hookId,
          optionIndex,
          pendingHookQuestion.sessionId,
          pendingHookQuestion.messageId,
          adapter,
          msg.chatId,
        );
        return true;
      }

      if (pendingSdkQuestion) {
        this.options.sdkEngine.getInteractionState().setSdkQuestionOptionAnswer(
          pendingSdkQuestion.permId,
          optionIndex,
        );
        this.options.permissions.getGateway().resolve(pendingSdkQuestion.permId, 'allow');
        return true;
      }
    }

    if (pendingHookQuestion) {
      await this.options.permissions.resolveAskQuestionWithText(
        pendingHookQuestion.hookId,
        trimmed,
        pendingHookQuestion.sessionId,
        pendingHookQuestion.messageId,
        adapter,
        msg.chatId,
      );
      return true;
    }

    if (pendingSdkQuestion) {
      this.options.sdkEngine.getInteractionState().setSdkQuestionTextAnswer(
        pendingSdkQuestion.permId,
        trimmed,
      );
      this.options.permissions.getGateway().resolve(pendingSdkQuestion.permId, 'allow');
      return true;
    }

    return false;
  }

  private getValidOptionIndex(
    trimmed: string,
    pendingHookQuestion: HookQuestion | null,
    pendingSdkQuestion: PendingSdkQuestion | null,
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
    const questionData = pendingHookQuestion
      ? this.options.permissions.getQuestionData(pendingHookQuestion.hookId)
      : pendingSdkQuestion
        ? interactionState.getSdkQuestion(pendingSdkQuestion.permId)
        : null;

    const optionsCount = questionData?.questions?.[0]?.options?.length ?? 0;
    return index < optionsCount ? index : null;
  }
}
