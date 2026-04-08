import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';
import { safeParseObject } from '../utils/json.js';
import type { PermissionCoordinator } from './permission-coordinator.js';
import type { SDKEngine } from './sdk-engine.js';
import type { SessionStateManager } from './session-state.js';

interface TextDispatcherOptions {
  permissions: PermissionCoordinator;
  sdkEngine: SDKEngine;
  state: SessionStateManager;
  coreUrl: string;
  token: string;
  isCoreAvailable: () => boolean;
}

type PendingSdkQuestion = {
  permId: string;
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
 * - quote-reply routing back into local PTY sessions
 */
export class TextDispatcher {
  constructor(private options: TextDispatcherOptions) {}

  hasPendingSdkQuestion(_channelType: string, chatId: string): boolean {
    return this.findPendingSdkQuestion(chatId) !== null;
  }

  async handle(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    if (msg.text && await this.handlePermissionText(adapter, msg)) {
      return true;
    }

    if (msg.text && await this.handleQuestionReply(adapter, msg)) {
      return true;
    }

    if ((msg.text || msg.attachments?.length) && msg.replyToMessageId && this.options.permissions.isHookMessage(msg.replyToMessageId)) {
      return this.handleHookReply(adapter, msg);
    }

    return false;
  }

  private findPendingSdkQuestion(chatId: string): PendingSdkQuestion | null {
    const { sdkQuestionData } = this.options.sdkEngine.getQuestionState();
    for (const [permId, data] of sdkQuestionData) {
      if (data.chatId === chatId && this.options.permissions.getGateway().isPending(permId)) {
        return { permId };
      }
    }
    return null;
  }

  private async handlePermissionText(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    const decision = this.options.permissions.parsePermissionText(msg.text);
    if (!decision) {
      return false;
    }

    const chatKey = this.options.state.stateKey(msg.channelType, msg.chatId);
    if (this.options.permissions.tryResolveByText(chatKey, decision)) {
      const emoji = decision === 'deny' ? 'NO' : decision === 'allow_always' ? 'DONE' : 'OK';
      adapter.addReaction(msg.chatId, msg.messageId, emoji).catch(() => {});
      return true;
    }

    if (this.options.permissions.pendingPermissionCount() > 1 && !msg.replyToMessageId) {
      const hint = adapter.channelType === 'feishu'
        ? '⚠️ 多个权限待审批，请引用回复具体的权限消息'
        : '⚠️ Multiple permissions pending — reply to the specific permission message';
      await adapter.send({ chatId: msg.chatId, text: hint });
      return true;
    }

    const permEntry = this.options.permissions.findHookPermission(msg.replyToMessageId, adapter.channelType);
    if (!permEntry || !this.options.isCoreAvailable()) {
      return false;
    }

    try {
      await this.options.permissions.resolveHookPermission(permEntry.permissionId, decision, adapter.channelType, this.options.isCoreAvailable());
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
          this.options.isCoreAvailable(),
        );
        return true;
      }

      if (pendingSdkQuestion) {
        const { sdkQuestionAnswers } = this.options.sdkEngine.getQuestionState();
        sdkQuestionAnswers.set(pendingSdkQuestion.permId, optionIndex);
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
        this.options.isCoreAvailable(),
      );
      return true;
    }

    if (pendingSdkQuestion) {
      const { sdkQuestionTextAnswers } = this.options.sdkEngine.getQuestionState();
      sdkQuestionTextAnswers.set(pendingSdkQuestion.permId, trimmed);
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

    const { sdkQuestionData } = this.options.sdkEngine.getQuestionState();
    const questionData = pendingHookQuestion
      ? this.options.permissions.getQuestionData(pendingHookQuestion.hookId)
      : pendingSdkQuestion
        ? sdkQuestionData.get(pendingSdkQuestion.permId)
        : null;

    const optionsCount = questionData?.questions?.[0]?.options?.length ?? 0;
    return index < optionsCount ? index : null;
  }

  private async handleHookReply(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    if (msg.text && this.options.isCoreAvailable()) {
      const handledQuestionRace = await this.handleHookQuestionRace(adapter, msg);
      if (handledQuestionRace) {
        return true;
      }
    }

    const entry = this.options.permissions.getHookMessage(msg.replyToMessageId!);
    if (!entry) {
      await adapter.send({ chatId: msg.chatId, text: '⚠️ Hook message expired or not found' });
      return true;
    }

    if (!entry.sessionId || !this.options.isCoreAvailable()) {
      await adapter.send({ chatId: msg.chatId, text: '⚠️ Local session not available (no session ID)' });
      return true;
    }

    try {
      let inputText = msg.text || '';
      if (msg.attachments?.length) {
        inputText = this.appendAttachmentPaths(inputText, msg.attachments);
      }
      await fetch(`${this.options.coreUrl}/api/sessions/${entry.sessionId}/input`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: inputText + '\r' }),
        signal: AbortSignal.timeout(5000),
      });
      await adapter.send({ chatId: msg.chatId, text: '✓ Sent to local session' });
    } catch (err) {
      await adapter.send({ chatId: msg.chatId, text: `❌ Failed to send: ${err}` });
    }

    return true;
  }

  private async handleHookQuestionRace(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    try {
      const pendingResp = await fetch(`${this.options.coreUrl}/api/hooks/pending`, {
        headers: { Authorization: `Bearer ${this.options.token}` },
        signal: AbortSignal.timeout(2000),
      });
      if (!pendingResp.ok) {
        return false;
      }

      const pending = await pendingResp.json() as Array<{ id: string; tool_name: string; input: unknown; session_id?: string }>;
      const askQuestion = pending.find(entry => entry.tool_name === 'AskUserQuestion');
      if (!askQuestion) {
        return false;
      }

      const inputData = safeParseObject(askQuestion.input as Record<string, unknown>);
      const questions = (inputData?.questions ?? []) as Array<{
        question: string;
        header: string;
        options: Array<{ label: string; description?: string }>;
        multiSelect: boolean;
      }>;
      if (questions.length === 0) {
        return false;
      }

      if (!this.options.permissions.getQuestionData(askQuestion.id)) {
        this.options.permissions.storeQuestionData(askQuestion.id, questions);
        this.options.permissions.trackPermissionMessage(msg.replyToMessageId!, askQuestion.id, askQuestion.session_id || '', adapter.channelType);
      }

      const trimmed = msg.text.trim();
      const optionIndex = this.getOptionIndexFromQuestion(trimmed, questions[0].options.length);
      if (optionIndex !== null) {
        await this.options.permissions.resolveAskQuestion(
          askQuestion.id,
          optionIndex,
          askQuestion.session_id || '',
          msg.replyToMessageId!,
          adapter,
          msg.chatId,
          this.options.isCoreAvailable(),
        );
      } else {
        await this.options.permissions.resolveAskQuestionWithText(
          askQuestion.id,
          trimmed,
          askQuestion.session_id || '',
          msg.replyToMessageId!,
          adapter,
          msg.chatId,
          this.options.isCoreAvailable(),
        );
      }
      return true;
    } catch {
      return false;
    }
  }

  private getOptionIndexFromQuestion(trimmed: string, optionsCount: number): number | null {
    const numericMatch = trimmed.match(/^(\d+)$/);
    if (!numericMatch) {
      return null;
    }

    const index = parseInt(numericMatch[1], 10) - 1;
    if (index < 0 || index >= optionsCount) {
      return null;
    }
    return index;
  }

  private appendAttachmentPaths(text: string, attachments: NonNullable<InboundMessage['attachments']>): string {
    let inputText = text;
    const imageDir = join(tmpdir(), 'tlive-images');
    mkdirSync(imageDir, { recursive: true });

    for (const attachment of attachments) {
      if (attachment.type !== 'image') {
        continue;
      }
      const ext = attachment.mimeType === 'image/png' ? '.png' : '.jpg';
      const filePath = join(imageDir, `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
      writeFileSync(filePath, Buffer.from(attachment.base64Data, 'base64'));
      inputText = inputText ? `${inputText}\n${filePath}` : filePath;
    }

    return inputText;
  }
}
