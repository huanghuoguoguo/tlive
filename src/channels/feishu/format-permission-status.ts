/**
 * Feishu permission status card.
 */

import type { Locale } from '../../i18n/index.js';
import { t } from '../../i18n/index.js';
import type { PermissionStatusData } from '../../formatting/message-types.js';
import type { Button } from '../../ui/types.js';
import { permStatusButtons } from '../../ui/buttons.js';
import { truncate } from '../../core/string.js';
import type { FeishuCardElement } from './card-builder.js';
import { mdElement } from './format-home.js';

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
    mdElement(
      `**${t(locale, 'perm.labelMode')}**\n${data.mode === 'on' ? t(locale, 'perm.labelModeOn') : t(locale, 'perm.labelModeOff')}`,
    ),
    mdElement(
      `**${t(locale, 'perm.labelSessionMemory')}**\n${t(locale, 'perm.labelTools')} ${data.rememberedTools} · ${t(locale, 'perm.labelBashPrefixes')} ${data.rememberedBashPrefixes}`,
    ),
  ];

  if (data.pending) {
    elements.push(
      mdElement(
        `**${t(locale, 'perm.pendingApproval')}**\n${data.pending.toolName}\n\`\`\`\n${truncate(data.pending.input, 220)}\n\`\`\``,
      ),
    );
  } else {
    elements.push(mdElement(`**${t(locale, 'perm.pendingApproval')}**\n${t(locale, 'perm.labelNoPending')}`));
  }

  if (data.lastDecision) {
    elements.push(
      mdElement(`**${t(locale, 'perm.lastDecision')}**\n${data.lastDecision.toolName} · ${decisionLabel}`),
    );
  }

  return elements;
}

export function permStatusButtonsForMode(mode: 'on' | 'off', locale: Locale): Button[] {
  return permStatusButtons(mode, locale);
}
