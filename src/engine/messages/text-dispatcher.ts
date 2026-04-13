import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import type { PermissionCoordinator } from '../coordinators/permission.js';
import type { SDKEngine } from '../sdk/engine.js';
import type { SessionStateManager } from '../state/session-state.js';

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

  hasPendingSdkQuestion(_channelType: string, chatId: string): boolean {
    return this.findPendingSdkQuestion(chatId) !== null;
  }

  hasPendingDeferredTool(_channelType: string, chatId: string): boolean {
    return this.findPendingDeferredTool(chatId) !== null;
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
      await adapter.send({ chatId: msg.chatId, text: '⚠️ Hook reply feature no longer available' });
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
    const pendingDeferred = this.findPendingDeferredTool(msg.chatId);
    if (!pendingDeferred) {
      return false;
    }

    const trimmed = msg.text.trim();
    if (trimmed.toLowerCase() === 'skip' || trimmed.toLowerCase() === '跳过') {
      this.options.permissions.getGateway().resolve(pendingDeferred.permId, 'deny', 'Skipped');
      this.options.sdkEngine.getInteractionState().cleanupDeferredTool(pendingDeferred.permId);
      await adapter.send({ chatId: msg.chatId, text: '⏭ 已跳过' });
      return true;
    }

    // Store user input and resolve permission
    this.options.sdkEngine.getInteractionState().setDeferredToolInput(pendingDeferred.permId, trimmed);
    this.options.permissions.getGateway().resolve(pendingDeferred.permId, 'allow');
    await adapter.send({ chatId: msg.chatId, text: `✅ 已提交输入: ${trimmed.slice(0, 50)}${trimmed.length > 50 ? '...' : ''}` });
    return true;
  }

  private async handlePermissionText(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    const decision = this.options.permissions.parsePermissionText(msg.text);
    if (!decision) {
      return false;
    }

    const chatKey = this.options.state.stateKey(msg.channelType, msg.chatId);
    if (this.options.permissions.tryResolveByText(chatKey, decision)) {
      const emoji = adapter.getPermissionDecisionReaction(decision);
      adapter.addReaction(msg.chatId, msg.messageId, emoji).catch(() => {});
      return true;
    }

    if (this.options.permissions.pendingPermissionCount() > 1 && !msg.replyToMessageId) {
      const hint = adapter.getLocale() === 'zh'
        ? '⚠️ 多个权限待审批，请引用回复具体的权限消息'
        : '⚠️ Multiple permissions pending — reply to the specific permission message';
      await adapter.send({ chatId: msg.chatId, text: hint });
      return true;
    }

    const permEntry = this.options.permissions.findHookPermission(msg.replyToMessageId, adapter.channelType);
    if (!permEntry) {
      return false;
    }

    // Hook permission resolution simplified (Go Core removed)
    try {
      await this.options.permissions.resolveHookPermission(permEntry.permissionId, decision, adapter.channelType);
      const label = decision === 'deny' ? '❌ Denied' : decision === 'allow_always' ? '📌 Always allowed' : '✅ Allowed';
      await adapter.send({ chatId: msg.chatId, text: label });
    } catch (err) {
      await adapter.send({ chatId: msg.chatId, text: `❌ Failed to resolve: ${err}` });
    }
    return true;
  }

  private async handleQuestionReply(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    const trimmed = msg.text.trim();
    const pendingHookQuestion = this.options.permissions.getLatestPendingQuestion(adapter.channelType);
    const pendingSdkQuestion = this.findPendingSdkQuestion(msg.chatId);

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
