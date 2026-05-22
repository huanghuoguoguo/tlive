/**
 * Feishu cards that collect user input during an agent turn.
 */

import type { Locale } from '../../i18n/index.js';
import { t } from '../../i18n/index.js';
import type {
  DeferredToolInputData,
  MultiSelectToggleData,
  QuestionData,
} from '../../formatting/message-types.js';
import type { Button } from '../../ui/types.js';
import type { FeishuCardElement } from './card-builder.js';
import { formElement, markdownElement } from './card-elements.js';

export interface FormatQuestionParams {
  chatId: string;
  data: QuestionData;
  locale: Locale;
}

export function buildQuestionElements(params: FormatQuestionParams): FeishuCardElement[] {
  const { data, locale } = params;
  const { question, options, multiSelect, permId } = data;

  const cardElements: FeishuCardElement[] = [
    markdownElement(`**${t(locale, 'perm.labelQuestion')}**\n${question}`),
  ];

  const useSelectDropdown = !multiSelect && options.length > 4;

  if (!useSelectDropdown) {
    const optionsList = options
      .map(
        (opt, i) =>
          `${i + 1}. **${opt.label}**${opt.description ? ` — ${opt.description}` : ''}`,
      )
      .join('\n');
    cardElements.push(markdownElement(`**${t(locale, 'perm.labelOptions')}**\n${optionsList}`));
    if (multiSelect) {
      cardElements.push(markdownElement(t(locale, 'perm.hintClickToggle')));
    } else {
      cardElements.push(markdownElement(t(locale, 'perm.hintClickOrText')));
    }
  }

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
    placeholder: {
      tag: 'plain_text',
      content: useSelectDropdown
        ? t(locale, 'perm.placeholderText')
        : t(locale, 'perm.placeholderTextInput'),
    },
    required: false,
  } as FeishuCardElement);

  cardElements.push(formElement(`form_${permId}`, formElements, buildQuestionButtons(data, locale)));

  return cardElements;
}

function buildQuestionButtons(data: QuestionData, locale: Locale): Button[] {
  const { options, multiSelect, permId, sessionId } = data;
  const useSelectDropdown = !multiSelect && options.length > 4;

  if (useSelectDropdown) {
    return [
      { label: t(locale, 'perm.btnSubmit'), callbackData: `form:${permId}`, style: 'primary', row: 0 },
      {
        label: t(locale, 'perm.btnSkip'),
        callbackData: `askq_skip:${permId}:${sessionId}`,
        style: 'default',
        row: 0,
      },
    ];
  }

  if (multiSelect) {
    return [
      ...options.map((opt, idx) => ({
        label: `☐ ${opt.label}`,
        callbackData: `askq_toggle:${permId}:${idx}:${sessionId}`,
        style: 'primary' as const,
        row: idx,
      })),
      {
        label: t(locale, 'perm.btnSubmit'),
        callbackData: `form:${permId}`,
        style: 'primary' as const,
        row: options.length,
      },
      {
        label: t(locale, 'perm.btnSkip'),
        callbackData: `askq_skip:${permId}:${sessionId}`,
        style: 'default',
        row: options.length,
      },
    ];
  }

  return [
    ...options.map((opt, idx) => ({
      label: `${idx + 1}. ${opt.label}`,
      callbackData: `perm:allow:${permId}:askq:${idx}`,
      style: 'primary' as const,
      row: idx,
    })),
    {
      label: t(locale, 'perm.btnSubmitText'),
      callbackData: `form:${permId}`,
      style: 'primary' as const,
      row: options.length,
    },
    {
      label: t(locale, 'perm.btnSkip'),
      callbackData: `askq_skip:${permId}:${sessionId}`,
      style: 'default',
      row: options.length,
    },
  ];
}

export interface FormatDeferredToolParams {
  chatId: string;
  data: DeferredToolInputData;
  locale: Locale;
}

export function buildDeferredToolElements(
  params: FormatDeferredToolParams,
): FeishuCardElement[] {
  const { data, locale } = params;
  const { toolName, prompt, permId, sessionId, inputPlaceholder } = data;

  const cardElements: FeishuCardElement[] = [
    markdownElement(`**${t(locale, 'perm.labelToolRequest')}**\n${toolName}`),
    markdownElement(`**${t(locale, 'perm.labelDescription')}**\n${prompt}`),
    markdownElement(`**${t(locale, 'perm.labelSessionInfo')}**\n${sessionId}`),
    markdownElement(t(locale, 'perm.hintInputSubmit')),
  ];

  const formElements: FeishuCardElement[] = [
    {
      tag: 'input',
      name: '_deferred_input',
      placeholder: {
        tag: 'plain_text',
        content: inputPlaceholder || t(locale, 'perm.placeholderInput'),
      },
      required: false,
    } as FeishuCardElement,
  ];

  const formButtons: Button[] = [
    { label: t(locale, 'perm.btnSubmit'), callbackData: `form:${permId}`, style: 'primary', row: 0 },
    {
      label: t(locale, 'perm.btnSkip'),
      callbackData: `deferred:skip:${permId}`,
      style: 'default',
      row: 0,
    },
  ];

  cardElements.push(formElement(`form_deferred_${permId}`, formElements, formButtons));

  return cardElements;
}

export interface FormatMultiSelectParams {
  chatId: string;
  data: MultiSelectToggleData;
  locale: Locale;
}

export function buildMultiSelectElements(params: FormatMultiSelectParams): FeishuCardElement[] {
  const { data, locale } = params;
  const optionsList = data.options
    .map(
      (opt, i) =>
        `${data.selectedIndices.has(i) ? '☑' : '☐'} ${i + 1}. **${opt.label}**${opt.description ? ` — ${opt.description}` : ''}`,
    )
    .join('\n');

  return [
    markdownElement(`**${t(locale, 'perm.labelQuestion')}**\n${data.question}`),
    markdownElement(`**${t(locale, 'perm.labelOptions')}**\n${optionsList}`),
    markdownElement(
      `**${t(locale, 'perm.labelDescription')}**\n${t(locale, 'perm.hintMultiSelect')}`,
    ),
  ];
}

export function buildMultiSelectButtons(
  permId: string,
  sessionId: string,
  options: Array<{ label: string; description?: string }>,
  locale: Locale,
): Button[] {
  return [
    ...options.map((opt, idx) => ({
      label: `☐ ${opt.label}`,
      callbackData: `askq_toggle:${permId}:${idx}:${sessionId}`,
      style: 'primary' as const,
      row: idx,
    })),
    {
      label: t(locale, 'perm.btnSubmit'),
      callbackData: `form:${permId}`,
      style: 'primary' as const,
      row: options.length,
    },
    {
      label: t(locale, 'perm.btnSkip'),
      callbackData: `askq_skip:${permId}:${sessionId}`,
      style: 'default' as const,
      row: options.length,
    },
  ];
}
