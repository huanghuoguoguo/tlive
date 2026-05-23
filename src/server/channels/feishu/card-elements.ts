import type { Button } from '../../../shared/ui/types.js';
import { buildFeishuButtonElements, type FeishuCardElement } from './card-builder.js';
import { downgradeHeadings, splitLargeTables } from './markdown.js';

export interface CollapsiblePanelOptions {
  expanded?: boolean;
}

export function markdownElement(content: string): FeishuCardElement {
  return { tag: 'markdown', content: downgradeHeadings(splitLargeTables(content)) };
}

export function buttonElements(buttons?: Button[]): FeishuCardElement[] {
  return buildFeishuButtonElements(buttons);
}

export function collapsiblePanel(
  title: string,
  elements: FeishuCardElement[],
  options: CollapsiblePanelOptions = {},
): FeishuCardElement {
  return {
    tag: 'collapsible_panel',
    expanded: options.expanded ?? false,
    header: { title: { tag: 'plain_text', content: title } },
    elements,
  };
}

export function markdownPanel(
  title: string,
  content: string,
  options?: CollapsiblePanelOptions,
): FeishuCardElement {
  return collapsiblePanel(title, [markdownElement(content)], options);
}

export function formElement(
  name: string,
  elements: FeishuCardElement[],
  buttons?: Button[],
): FeishuCardElement {
  return {
    tag: 'form',
    name,
    elements: [...elements, ...buttonElements(buttons)],
  };
}

export function dividerElement(): FeishuCardElement {
  return { tag: 'hr' };
}
