/**
 * Feishu permission and question formatting - extracted from main formatter.
 */

import type { Locale } from '../../i18n/index.js';
import { t } from '../../i18n/index.js';
import type { FeishuCardElement } from './card-builder.js';
import { buildFeishuButtonElements } from './card-builder.js';
import type {
  PermissionData,
  QuestionData,
  DeferredToolInputData,
  PermissionStatusData,
  MultiSelectToggleData,
} from '../../formatting/message-types.js';
import type { Button } from '../../ui/types.js';
import {
  permissionButtons,
  permStatusButtons,
} from '../../ui/buttons.js';
import { truncate } from '../../utils/string.js';
import { mdElement } from './format-home.js';

export interface FormatPermissionParams {
  chatId: string;
  data: PermissionData;
  locale: Locale;
}

export function buildPermissionElements(params: FormatPermissionParams): FeishuCardElement[] {
  const { data, locale } = params;
  const input = truncate(data.toolInput, 300);
  const expires = data.expiresInMinutes ?? 5;
  const elements: FeishuCardElement[] = [
    mdElement(`**${t(locale, 'perm.labelTool')}**\n${data.toolName}`),
    mdElement(`**${t(locale, 'perm.labelInput')}**\n\`\`\`\n${input}\n\`\`\``),
    mdElement(`⏱ ${expires} ${t(locale, 'perm.labelExpiresIn')}`),
  ];
  if (data.terminalUrl) {
    elements.push(mdElement(`${t(locale, 'perm.labelViewInTerminal')} [link](${data.terminalUrl})`));
  }
  elements.push(mdElement(t(locale, 'perm.hintReply')));
  return elements;
}

export function permissionFormatButtons(data: PermissionData, locale: Locale): Button[] {
  return permissionButtons(data.permissionId, locale);
}

export interface FormatQuestionParams {
  chatId: string;
  data: QuestionData;
  locale: Locale;
}

export function buildQuestionElements(params: FormatQuestionParams): FeishuCardElement[] {
  const { data, locale } = params;
  const { question, options, multiSelect, permId } = data;

  const cardElements: FeishuCardElement[] = [
    mdElement(`**${t(locale, 'perm.labelQuestion')}**\n${question}`),
  ];

  const useSelectDropdown = !multiSelect && options.length > 4;

  if (!useSelectDropdown) {
    const optionsList = options
      .map((opt, i) => `${i + 1}. **${opt.label}**${opt.description ? ` — ${opt.description}` : ''}`)
      .join('\n');
    cardElements.push(mdElement(`**${t(locale, 'perm.labelOptions')}**\n${optionsList}`));
    if (multiSelect) {
      cardElements.push(mdElement(t(locale, 'perm.hintClickToggle')));
    } else {
      cardElements.push(mdElement(t(locale, 'perm.hintClickOrText')));
    }
  }

  // Build form elements
  const formElements: FeishuCardElement[] = [];

  if (useSelectDropdown) {
    formElements.push({
      tag: 'select_static',
      name: '_select',
      placeholder: { tag: 'plain_text', content: t(locale, 'perm.placeholderSelect') },
      options: options.map(opt => ({
        text: { tag: 'plain_text', content: opt.label },
        value: opt.label,
      })),
      required: false,
    } as FeishuCardElement);
  }

  formElements.push({
    tag: 'input',
    name: '_text_answer',
    placeholder: { tag: 'plain_text', content: useSelectDropdown ? t(locale, 'perm.placeholderText') : t(locale, 'perm.placeholderTextInput') },
    required: false,
  } as FeishuCardElement);

  const formButtons = buildQuestionButtons(data, locale);
  const formContainer: FeishuCardElement = {
    tag: 'form',
    name: `form_${permId}`,
    elements: [
      ...formElements as unknown as { tag: string; content: string }[],
      ...buildFeishuButtonElements(formButtons) as unknown as { tag: string; content: string }[],
    ],
  };

  cardElements.push(formContainer);
  return cardElements;
}

function buildQuestionButtons(data: QuestionData, locale: Locale): Button[] {
  const { options, multiSelect, permId, sessionId } = data;
  const useSelectDropdown = !multiSelect && options.length > 4;
  const formButtons: Button[] = [];

  if (useSelectDropdown) {
    formButtons.push({ label: t(locale, 'perm.btnSubmit'), callbackData: `form:${permId}`, style: 'primary', row: 0 });
    formButtons.push({ label: t(locale, 'perm.btnSkip'), callbackData: `askq_skip:${permId}:${sessionId}`, style: 'default', row: 0 });
  } else if (multiSelect) {
    formButtons.push(...options.map((opt, idx) => ({
      label: `☐ ${opt.label}`,
      callbackData: `askq_toggle:${permId}:${idx}:${sessionId}`,
      style: 'primary' as const,
      row: idx,
    })));
    formButtons.push({ label: t(locale, 'perm.btnSubmit'), callbackData: `form:${permId}`, style: 'primary', row: options.length });
    formButtons.push({ label: t(locale, 'perm.btnSkip'), callbackData: `askq_skip:${permId}:${sessionId}`, style: 'default', row: options.length });
  } else {
    formButtons.push(...options.map((opt, idx) => ({
      label: `${idx + 1}. ${opt.label}`,
      callbackData: `perm:allow:${permId}:askq:${idx}`,
      style: 'primary' as const,
      row: idx,
    })));
    formButtons.push({ label: t(locale, 'perm.btnSubmitText'), callbackData: `form:${permId}`, style: 'primary', row: options.length });
    formButtons.push({ label: t(locale, 'perm.btnSkip'), callbackData: `askq_skip:${permId}:${sessionId}`, style: 'default', row: options.length });
  }

  return formButtons;
}

export interface FormatDeferredToolParams {
  chatId: string;
  data: DeferredToolInputData;
  locale: Locale;
}

export function buildDeferredToolElements(params: FormatDeferredToolParams): FeishuCardElement[] {
  const { data, locale } = params;
  const { toolName, prompt, permId, sessionId, inputPlaceholder } = data;

  const cardElements: FeishuCardElement[] = [
    mdElement(`**${t(locale, 'perm.labelToolRequest')}**\n${toolName}`),
    mdElement(`**${t(locale, 'perm.labelDescription')}**\n${prompt}`),
    mdElement(`**${t(locale, 'perm.labelSessionInfo')}**\n${sessionId}`),
    mdElement(t(locale, 'perm.hintInputSubmit')),
  ];

  const formElements: FeishuCardElement[] = [
    {
      tag: 'input',
      name: '_deferred_input',
      placeholder: { tag: 'plain_text', content: inputPlaceholder || t(locale, 'perm.placeholderInput') },
      required: false,
    } as FeishuCardElement,
  ];

  const formButtons: Button[] = [
    { label: t(locale, 'perm.btnSubmit'), callbackData: `form:${permId}`, style: 'primary' as const, row: 0 },
    { label: t(locale, 'perm.btnSkip'), callbackData: `deferred:skip:${permId}`, style: 'default' as const, row: 0 },
  ];

  const formContainer: FeishuCardElement = {
    tag: 'form',
    name: `form_deferred_${permId}`,
    elements: [
      ...formElements as unknown as { tag: string; content: string }[],
      ...buildFeishuButtonElements(formButtons) as unknown as { tag: string; content: string }[],
    ],
  };

  cardElements.push(formContainer);
  return cardElements;
}

export interface FormatPermStatusParams {
  chatId: string;
  data: PermissionStatusData;
  locale: Locale;
}

export function buildPermStatusElements(params: FormatPermStatusParams): FeishuCardElement[] {
  const { data, locale } = params;
  const decisionLabel = data.lastDecision
    ? {
        allow: t(locale, 'perm.decisionAllow'),
        allow_always: t(locale, 'perm.decisionAlwaysAllow'),
        deny: t(locale, 'perm.decisionDeny'),
        cancelled: t(locale, 'perm.decisionCancelled'),
      }[data.lastDecision.decision]
    : '';

  const elements: FeishuCardElement[] = [
    mdElement(`**${t(locale, 'perm.labelMode')}**\n${data.mode === 'on' ? t(locale, 'perm.labelModeOn') : t(locale, 'perm.labelModeOff')}`),
    mdElement(`**${t(locale, 'perm.labelSessionMemory')}**\n${t(locale, 'perm.labelTools')} ${data.rememberedTools} · ${t(locale, 'perm.labelBashPrefixes')} ${data.rememberedBashPrefixes}`),
  ];

  if (data.pending) {
    elements.push(mdElement(`**${t(locale, 'perm.pendingApproval')}**\n${data.pending.toolName}\n\`\`\`\n${truncate(data.pending.input, 220)}\n\`\`\``));
  } else {
    elements.push(mdElement(`**${t(locale, 'perm.pendingApproval')}**\n${t(locale, 'perm.labelNoPending')}`));
  }

  if (data.lastDecision) {
    elements.push(mdElement(`**${t(locale, 'perm.lastDecision')}**\n${data.lastDecision.toolName} · ${decisionLabel}`));
  }

  return elements;
}

export function permStatusButtonsForMode(mode: 'on' | 'off', locale: Locale): Button[] {
  return permStatusButtons(mode, locale);
}

export interface FormatMultiSelectParams {
  chatId: string;
  data: MultiSelectToggleData;
  locale: Locale;
}

export function buildMultiSelectElements(params: FormatMultiSelectParams): FeishuCardElement[] {
  const { data, locale } = params;
  const optionsList = data.options
    .map((opt, i) => `${data.selectedIndices.has(i) ? '☑' : '☐'} ${i + 1}. **${opt.label}**${opt.description ? ` — ${opt.description}` : ''}`)
    .join('\n');

  const elements: FeishuCardElement[] = [
    mdElement(`**${t(locale, 'perm.labelQuestion')}**\n${data.question}`),
    mdElement(`**${t(locale, 'perm.labelOptions')}**\n${optionsList}`),
    mdElement(`**${t(locale, 'perm.labelDescription')}**\n${t(locale, 'perm.hintMultiSelect')}`),
  ];

  return elements;
}

export function buildMultiSelectButtons(permId: string, sessionId: string, options: Array<{ label: string; description?: string }>, locale: Locale): Button[] {
  const buttons: Button[] = options.map((opt, idx) => ({
    label: `☐ ${opt.label}`,
    callbackData: `askq_toggle:${permId}:${idx}:${sessionId}`,
    style: 'primary' as const,
    row: idx,
  }));
  buttons.push({ label: t(locale, 'perm.btnSubmit'), callbackData: `form:${permId}`, style: 'primary' as const, row: options.length });
  buttons.push({ label: t(locale, 'perm.btnSkip'), callbackData: `askq_skip:${permId}:${sessionId}`, style: 'default' as const, row: options.length });
  return buttons;
}