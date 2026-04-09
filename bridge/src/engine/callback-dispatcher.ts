import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';
import type { PermissionCoordinator } from './permission-coordinator.js';
import type { SDKEngine } from './sdk-engine.js';
import {
  CALLBACK_PREFIXES,
} from '../utils/constants.js';
import {
  parseAskqCallback,
  parseAskqSubmitCallback,
  parseAskqSubmitSdkCallback,
  parseAskqSkipCallback,
  parseAskqToggleCallback,
  parseCallback,
  parseHookCallback,
} from '../utils/callback.js';

interface CallbackDispatcherDeps {
  permissions: PermissionCoordinator;
  sdkEngine: SDKEngine;
  replayMessage: (adapter: BaseChannelAdapter, msg: InboundMessage) => Promise<boolean>;
}

export async function handleCallbackMessage(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  deps: CallbackDispatcherDeps,
): Promise<boolean> {
  if (!msg.callbackData) return false;

  // Prompt suggestion callback — re-inject as a normal user message
  if (msg.callbackData.startsWith('suggest:')) {
    const suggestion = msg.callbackData.slice('suggest:'.length);
    msg.text = suggestion;
    msg.callbackData = undefined;
    return deps.replayMessage(adapter, msg);
  }

  const askqParsed = parseAskqCallback(msg.callbackData);
  if (askqParsed) {
    await deps.permissions.resolveAskQuestion(
      askqParsed.hookId,
      askqParsed.optionIndex,
      askqParsed.sessionId,
      msg.messageId,
      adapter,
      msg.chatId,
    );
    return true;
  }

  const askqToggleParsed = parseAskqToggleCallback(msg.callbackData);
  if (askqToggleParsed) {
    const selected = deps.permissions.toggleMultiSelectOption(
      askqToggleParsed.hookId,
      askqToggleParsed.optionIndex,
    );
    if (selected === null) return true;

    const card = deps.permissions.buildMultiSelectCard(
      askqToggleParsed.hookId,
      askqToggleParsed.sessionId,
      selected,
      adapter.channelType,
    );
    if (card) {
      await adapter.editMessage(msg.chatId, msg.messageId, {
        chatId: msg.chatId,
        text: card.text,
        html: card.html,
        buttons: card.buttons,
        feishuHeader:
          adapter.channelType === 'feishu'
            ? { template: 'blue', title: '❓ Terminal' }
            : undefined,
      });
    }
    return true;
  }

  const askqSubmitParsed = parseAskqSubmitCallback(msg.callbackData);
  if (askqSubmitParsed) {
    await deps.permissions.resolveMultiSelect(
      askqSubmitParsed.hookId,
      askqSubmitParsed.sessionId,
      msg.messageId,
      adapter,
      msg.chatId,
    );
    return true;
  }

  const askqSkipParsed = parseAskqSkipCallback(msg.callbackData);
  if (askqSkipParsed) {
    await deps.permissions.resolveAskQuestionSkip(
      askqSkipParsed.hookId,
      askqSkipParsed.sessionId,
      msg.messageId,
      adapter,
      msg.chatId,
    );
    return true;
  }

  const askqSubmitSdkParsed = parseAskqSubmitSdkCallback(msg.callbackData);
  if (askqSubmitSdkParsed) {
    const permId = askqSubmitSdkParsed.permId;
    const selected = deps.permissions.getToggledSelections(permId);
    if (selected.size === 0) {
      await adapter.send({ chatId: msg.chatId, text: '⚠️ No options selected' });
      return true;
    }
    const { sdkQuestionData, sdkQuestionTextAnswers } = deps.sdkEngine.getQuestionState();
    const qData = sdkQuestionData.get(permId);
    if (qData) {
      const q = qData.questions[0];
      const selectedLabels = [...selected]
        .sort((a, b) => a - b)
        .map(i => q.options[i]?.label)
        .filter(Boolean);
      const answerText = selectedLabels.join(',');
      sdkQuestionTextAnswers.set(permId, answerText);
      adapter
        .editMessage(msg.chatId, msg.messageId, {
          chatId: msg.chatId,
          text: `✅ Selected: ${selectedLabels.join(', ')}`,
          buttons: [],
          feishuHeader:
            msg.channelType === 'feishu'
              ? { template: 'green', title: '✅ Answered' }
              : undefined,
        })
        .catch(() => {});
    }
    deps.permissions.cleanupQuestion(permId);
    deps.permissions.getGateway().resolve(permId, 'allow');
    return true;
  }

  // Command shortcuts from help menu buttons
  if (msg.callbackData.startsWith('cmd:')) {
    const cmd = msg.callbackData.slice(4);
    const cmdMsg: InboundMessage = {
      channelType: msg.channelType,
      chatId: msg.chatId,
      text: `/${cmd}`,
      userId: msg.userId,
      messageId: msg.messageId,
    };
    await deps.replayMessage(adapter, cmdMsg);
    return true;
  }

  const hookParsed = parseHookCallback(msg.callbackData);
  if (hookParsed) {
    await deps.permissions.resolveHookCallback(
      hookParsed.hookId,
      hookParsed.decision,
      hookParsed.sessionId,
      msg.messageId,
      adapter,
      msg.chatId,
    );
    return true;
  }

  if (msg.callbackData.startsWith(CALLBACK_PREFIXES.PERM_ALLOW_EDITS)) {
    const permId = msg.callbackData.slice(CALLBACK_PREFIXES.PERM_ALLOW_EDITS.length);
    deps.permissions.getGateway().resolve(permId, 'allow');
    return true;
  }

  if (msg.callbackData.startsWith(CALLBACK_PREFIXES.PERM_ALLOW_TOOL)) {
    const parts = parseCallback(msg.callbackData);
    const permId = parts[2];
    const toolName = parts.slice(3).join(':');
    deps.permissions.getGateway().resolve(permId, 'allow');
    deps.permissions.addAllowedTool(toolName);
    console.log(`[bridge] Added ${toolName} to session whitelist`);
    return true;
  }

  if (msg.callbackData.startsWith(CALLBACK_PREFIXES.PERM_ALLOW_BASH)) {
    const parts = parseCallback(msg.callbackData);
    const permId = parts[2];
    const prefix = parts.slice(3).join(':');
    deps.permissions.getGateway().resolve(permId, 'allow');
    deps.permissions.addAllowedBashPrefix(prefix);
    console.log(`[bridge] Added Bash(${prefix} *) to session whitelist`);
    return true;
  }

  if (msg.callbackData.includes(':askq:')) {
    const parts = msg.callbackData.split(':');
    const askqIdx = parts.indexOf('askq');
    if (askqIdx >= 0) {
      const permId = parts.slice(2, askqIdx).join(':');
      const optionIndex = parseInt(parts[askqIdx + 1], 10);
      const { sdkQuestionData, sdkQuestionAnswers } = deps.sdkEngine.getQuestionState();
      const qData = sdkQuestionData.get(permId);
      const selected = qData?.questions?.[0]?.options?.[optionIndex];
      if (!selected) return true;

      sdkQuestionAnswers.set(permId, optionIndex);
      deps.permissions.getGateway().resolve(permId, 'allow');
      adapter
        .editMessage(msg.chatId, msg.messageId, {
          chatId: msg.chatId,
          text: `✅ Selected: ${selected.label}`,
          buttons: [],
          feishuHeader: { template: 'green', title: `✅ ${selected.label}` },
        })
        .catch(() => {});
      return true;
    }
  }

  if (msg.callbackData.includes(':askq_skip')) {
    const parts = msg.callbackData.split(':');
    const skipIdx = parts.indexOf('askq_skip');
    if (skipIdx >= 0) {
      const permId = parts.slice(2, skipIdx).join(':');
      deps.permissions.getGateway().resolve(permId, 'deny', 'Skipped');
      adapter
        .editMessage(msg.chatId, msg.messageId, {
          chatId: msg.chatId,
          text: '⏭ Skipped',
          buttons: [],
          feishuHeader: { template: 'grey', title: '⏭ Skipped' },
        })
        .catch(() => {});
      return true;
    }
  }

  console.log(
    `[bridge] Perm callback: ${msg.callbackData}, gateway pending: ${deps.permissions.getGateway().pendingCount()}`,
  );
  deps.permissions.handleBrokerCallback(msg.callbackData);
  return true;
}
