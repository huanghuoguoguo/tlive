import type { HelpData } from '../../formatting/message-types.js';
import { groupHelpCommands } from '../../formatting/help-format.js';
import type { FeishuCardElement } from './card-builder.js';
import { mdElement } from './format-home.js';

export function buildHelpElements(data: HelpData): FeishuCardElement[] {
  const elements: FeishuCardElement[] = [];

  for (const group of groupHelpCommands(data.commands)) {
    const panelElements: FeishuCardElement[] = [];
    for (const cmd of group.commands) {
      let text = `**/${cmd.cmd}** — ${cmd.desc}`;
      if (cmd.detail) {
        text += `\n${cmd.detail}`;
      }
      if (cmd.example) {
        text += `\n📌 示例: \`${cmd.example}\``;
      }
      panelElements.push(mdElement(text));
      panelElements.push(mdElement('---'));
    }
    panelElements.pop();

    elements.push({
      tag: 'collapsible_panel',
      expanded: group.category.expandedByDefault ?? false,
      header: { title: { tag: 'plain_text', content: `${group.category.icon} ${group.category.title}` } },
      elements: panelElements,
    } as FeishuCardElement);
  }

  return elements;
}

