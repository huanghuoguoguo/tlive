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
import { markdownElement } from './card-elements.js';

export interface FormatPermStatusParams {
  chatId: string;
  data: PermissionStatusData;
  locale: Locale;
}

export function buildPermStatusElements(params: FormatPermStatusParams): FeishuCardElement[] {
  const { data } = params;
  const decisionLabel = data.lastDecision
    ? {
        allow: t('perm.decisionAllow'),
        allow_always: t('perm.decisionAlwaysAllow'),
        deny: t('perm.decisionDeny'),
        cancelled: t('perm.decisionCancelled'),
      }[data.lastDecision.decision]
    : '';

  const elements: FeishuCardElement[] = [
    markdownElement(
      `**${t('perm.labelMode')}**\n${data.mode === 'on' ? t('perm.labelModeOn') : t('perm.labelModeOff')}`,
    ),
    markdownElement(
      `**${t('perm.labelSessionMemory')}**\n${t('perm.labelTools')} ${data.rememberedTools} · ${t('perm.labelBashPrefixes')} ${data.rememberedBashPrefixes}`,
    ),
  ];

  if (data.pending) {
    elements.push(
      markdownElement(
        `**${t('perm.pendingApproval')}**\n${data.pending.toolName}\n\`\`\`\n${truncate(data.pending.input, 220)}\n\`\`\``,
      ),
    );
  } else {
    elements.push(
      markdownElement(
        `**${t('perm.pendingApproval')}**\n${t('perm.labelNoPending')}`,
      ),
    );
  }

  if (data.lastDecision) {
    elements.push(
      markdownElement(
        `**${t('perm.lastDecision')}**\n${data.lastDecision.toolName} · ${decisionLabel}`,
      ),
    );
  }

  return elements;
}

export function permStatusButtonsForMode(
  mode: 'on' | 'off',
  locale: Locale,
  route?: PermissionStatusData['route'],
): Button[] {
  return permStatusButtons(mode, locale, route);
}
