import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import type { PermissionCoordinator } from '../coordinators/permission.js';
import type { SDKEngine } from '../sdk/engine.js';
import { truncate } from '../../core/string.js';
import {
  CALLBACK_PREFIXES,
} from '../../engine/constants.js';
import {
  parseAskqCallback,
  parseAskqSubmitCallback,
  parseAskqSubmitSdkCallback,
  parseAskqSkipCallback,
  parseAskqToggleCallback,
  parseCallback,
  parseHookCallback,
  parseFormCallback,
  parseDeferredSubmitCallback,
  parseDeferredSkipCallback,
} from '../../engine/messages/callback-utils.js';

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

    const qData = deps.permissions.getQuestionData(askqToggleParsed.hookId);
    if (qData) {
      const q = qData.questions[0];
      const outMsg = adapter.format({
        type: 'multiSelectToggle',
        chatId: msg.chatId,
        data: {
          question: q.question,
          header: q.header,
          options: q.options,
          selectedIndices: selected,
          permId: askqToggleParsed.hookId,
          sessionId: askqToggleParsed.sessionId,
        },
      });
      await adapter.editMessage(msg.chatId, msg.messageId, outMsg);
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
    const interactionState = deps.sdkEngine.getInteractionState();
    const qData = interactionState.getSdkQuestion(permId);
    if (qData) {
      const q = qData.questions[0];
      const selectedLabels = [...selected]
        .sort((a, b) => a - b)
        .map(i => q.options[i]?.label)
        .filter(Boolean);
      const answerText = selectedLabels.join(',');
      interactionState.setSdkQuestionTextAnswer(permId, answerText);
      adapter.editCardResolution(msg.chatId, msg.messageId, {
        resolution: 'answered',
        label: `✅ Selected: ${selectedLabels.join(', ')}`,
      }).catch(() => {});
    }
    deps.permissions.cleanupQuestion(permId);
    deps.permissions.getGateway().resolve(permId, 'allow');
    return true;
  }

  // Deferred tool callbacks
  const deferredSubmitParsed = parseDeferredSubmitCallback(msg.callbackData);
  if (deferredSubmitParsed) {
    const permId = deferredSubmitParsed.permId;
    const interactionState = deps.sdkEngine.getInteractionState();
    // Check for form input with deferred tool input
    const deferredData = interactionState.getDeferredTool(permId);
    if (deferredData) {
      // The form submission will be handled separately with formData
      // This callback just confirms the user wants to submit
      adapter.editCardResolution(msg.chatId, msg.messageId, {
        resolution: 'answered',
        label: '✅ Submitted',
      }).catch(() => {});
    }
    deps.permissions.getGateway().resolve(permId, 'allow');
    return true;
  }

  const deferredSkipParsed = parseDeferredSkipCallback(msg.callbackData);
  if (deferredSkipParsed) {
    const permId = deferredSkipParsed.permId;
    deps.permissions.getGateway().resolve(permId, 'deny', 'Skipped');
    deps.sdkEngine.getInteractionState().cleanupDeferredTool(permId);
    adapter.editCardResolution(msg.chatId, msg.messageId, {
      resolution: 'skipped',
      label: '⏭ Skipped',
    }).catch(() => {});
    return true;
  }

  // Form submission callback (from Feishu form_input/form_select)
  const formParsed = parseFormCallback(msg.callbackData);
  if (formParsed) {
    const { interactionId, formData } = formParsed;
    const permId = interactionId;
    const interactionState = deps.sdkEngine.getInteractionState();

    // Handle session selection form: form:session_select:{JSON}
    if (interactionId === 'session_select') {
      const sessionIdx = (formData._session_idx || formData.session_idx || '').trim();
      const idx = parseInt(sessionIdx, 10);
      // Only validate that input is a positive number - let /session command handle range validation
      if (idx > 0) {
        // Valid input - execute /session command
        const cmdMsg: InboundMessage = {
          channelType: msg.channelType,
          chatId: msg.chatId,
          text: `/session ${idx}`,
          userId: msg.userId,
          messageId: msg.messageId,
        };
        await deps.replayMessage(adapter, cmdMsg);
        return true;
      }
      // Invalid input - show error
      await adapter.send({ chatId: msg.chatId, text: `⚠️ 无效编号: "${sessionIdx}"，请输入正整数。` });
      return true;
    }

    // Check for deferred tool input first
    const deferredData = interactionState.getDeferredTool(permId);
    if (deferredData) {
      const deferredInput = (formData._deferred_input || formData.deferred_input || '').trim();
      if (deferredInput) {
        interactionState.setDeferredToolInput(permId, deferredInput);
        adapter.editCardResolution(msg.chatId, msg.messageId, {
          resolution: 'answered',
          label: `✅ Input: ${truncate(deferredInput, 50)}`,
        }).catch(() => {});
        deps.permissions.getGateway().resolve(permId, 'allow');
        return true;
      }
      // No input provided, allow without input
      deps.permissions.getGateway().resolve(permId, 'allow');
      return true;
    }

    const qData = interactionState.getSdkQuestion(permId);

    if (qData) {
      const q = qData.questions[0];
      // Check for text input (form_input)
      const textAnswer = (formData._text_answer || formData.text || '').trim();
      if (textAnswer) {
        interactionState.setSdkQuestionTextAnswer(permId, textAnswer);
        adapter.editCardResolution(msg.chatId, msg.messageId, {
          resolution: 'answered',
          label: `✅ Answer: ${truncate(textAnswer, 50)}`,
        }).catch(() => {});
        deps.permissions.cleanupQuestion(permId);
        deps.permissions.getGateway().resolve(permId, 'allow');
        return true;
      }

      // Check for select option (form_select)
      const selectValue = (formData._select || '').trim();
      if (selectValue) {
        // Find the option index by matching the value
        const optionIndex = q.options.findIndex(opt => opt.label === selectValue);
        if (optionIndex >= 0) {
          interactionState.setSdkQuestionOptionAnswer(permId, optionIndex);
          adapter.editCardResolution(msg.chatId, msg.messageId, {
            resolution: 'selected',
            label: `✅ ${selectValue}`,
          }).catch(() => {});
          deps.permissions.cleanupQuestion(permId);
          deps.permissions.getGateway().resolve(permId, 'allow');
          return true;
        }

        if (msg.chatId) {
          await adapter.send({ chatId: msg.chatId, text: '⚠️ Invalid selection, please try again.' });
        }
        return true;
      }

      if (msg.chatId) {
        await adapter.send({ chatId: msg.chatId, text: '⚠️ Please enter an answer or choose an option before submitting.' });
      }
    } else {
      console.warn(`[bridge] Form submission for unknown question: ${permId}`);
    }
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
    const hasSessionScope = parts.length >= 5;
    const sessionId = hasSessionScope ? parts[3] : undefined;
    const toolName = parts.slice(hasSessionScope ? 4 : 3).join(':');
    deps.permissions.getGateway().resolve(permId, 'allow');
    deps.permissions.addAllowedTool(sessionId, toolName);
    console.log(`[bridge] Added ${toolName} to session whitelist${sessionId ? ` (${sessionId})` : ''}`);
    return true;
  }

  if (msg.callbackData.startsWith(CALLBACK_PREFIXES.PERM_ALLOW_BASH)) {
    const parts = parseCallback(msg.callbackData);
    const permId = parts[2];
    const hasSessionScope = parts.length >= 5;
    const sessionId = hasSessionScope ? parts[3] : undefined;
    const prefix = parts.slice(hasSessionScope ? 4 : 3).join(':');
    deps.permissions.getGateway().resolve(permId, 'allow');
    deps.permissions.addAllowedBashPrefix(sessionId, prefix);
    console.log(`[bridge] Added Bash(${prefix} *) to session whitelist${sessionId ? ` (${sessionId})` : ''}`);
    return true;
  }

  if (msg.callbackData.includes(':askq:')) {
    const parts = msg.callbackData.split(':');
    const askqIdx = parts.indexOf('askq');
    if (askqIdx >= 0) {
      const permId = parts.slice(2, askqIdx).join(':');
      const optionIndex = parseInt(parts[askqIdx + 1], 10);
      const interactionState = deps.sdkEngine.getInteractionState();
      const qData = interactionState.getSdkQuestion(permId);
      const selected = qData?.questions?.[0]?.options?.[optionIndex];
      if (!selected) return true;

      interactionState.setSdkQuestionOptionAnswer(permId, optionIndex);
      deps.permissions.getGateway().resolve(permId, 'allow');
      adapter.editCardResolution(msg.chatId, msg.messageId, {
        resolution: 'selected',
        label: `✅ ${selected.label}`,
      }).catch(() => {});
      return true;
    }
  }

  if (msg.callbackData.includes(':askq_skip')) {
    const parts = msg.callbackData.split(':');
    const skipIdx = parts.indexOf('askq_skip');
    if (skipIdx >= 0) {
      const permId = parts.slice(2, skipIdx).join(':');
      deps.permissions.getGateway().resolve(permId, 'deny', 'Skipped');
      deps.sdkEngine.getInteractionState().cleanupSdkQuestion(permId);
      adapter.editCardResolution(msg.chatId, msg.messageId, {
        resolution: 'skipped',
        label: '⏭ Skipped',
      }).catch(() => {});
      return true;
    }
  }

  console.log(
    `[bridge] Perm callback: ${msg.callbackData}, gateway pending: ${deps.permissions.getGateway().pendingCount()}`,
  );
  deps.permissions.handleBrokerCallback(msg.callbackData);
  return true;
}
