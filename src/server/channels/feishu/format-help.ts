import type { HelpData } from '../../../shared/formatting/message-types.js';
import { groupHelpCommands } from '../../../shared/formatting/help-format.js';
import type { FeishuCardElement } from './card-builder.js';
import { collapsiblePanel, markdownElement } from './card-elements.js';
import type { Locale, TranslationKey } from '../../../shared/i18n/index.js';
import { t } from '../../../shared/i18n/index.js';

export function buildHelpElements(data: HelpData, _locale: Locale): FeishuCardElement[] {
  const elements: FeishuCardElement[] = [];

  for (const group of groupHelpCommands(data.commands)) {
    const panelElements: FeishuCardElement[] = [];
    for (const cmd of group.commands) {
      let text = `**/${cmd.cmd}** — ${cmd.desc}`;
      if (cmd.detail) {
        text += `\n${cmd.detail}`;
      }
      if (cmd.example) {
        text += `\n${t('help.exampleLabel')}: \`${cmd.example}\``;
      }
      panelElements.push(markdownElement(text));
      panelElements.push(markdownElement('---'));
    }
    panelElements.pop();

    // Resolve category title translation key
    const categoryTitle = t(group.category.title as TranslationKey);
    elements.push(
      collapsiblePanel(`${group.category.icon} ${categoryTitle}`, panelElements, {
        expanded: group.category.expandedByDefault ?? false,
      }),
    );
  }

  return elements;
}
