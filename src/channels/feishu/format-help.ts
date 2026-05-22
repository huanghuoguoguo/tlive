import type { HelpData } from '../../formatting/message-types.js';
import { groupHelpCommands } from '../../formatting/help-format.js';
import type { FeishuCardElement } from './card-builder.js';
import { collapsiblePanel, markdownElement } from './card-elements.js';

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
      panelElements.push(markdownElement(text));
      panelElements.push(markdownElement('---'));
    }
    panelElements.pop();

    elements.push(
      collapsiblePanel(`${group.category.icon} ${group.category.title}`, panelElements, {
        expanded: group.category.expandedByDefault ?? false,
      }),
    );
  }

  return elements;
}
