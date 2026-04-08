import type { FeishuCardElement } from './types.js';
import type { Button } from '../channels/types.js';

export type FeishuHeaderTemplate = 'blue' | 'green' | 'orange' | 'red' | 'purple' | 'indigo' | 'yellow' | 'turquoise';

export interface FeishuCardOptions {
  header?: {
    template: FeishuHeaderTemplate;
    title: string;
  };
  elements: FeishuCardElement[];
}

export function buildFeishuButtonElements(buttons?: Button[]): FeishuCardElement[] {
  if (!buttons?.length) return [];

  const makeButton = (btn: Button) => ({
    tag: 'column' as const,
    width: 'auto' as const,
    vertical_align: 'top' as const,
    elements: [{
      tag: 'button' as const,
      text: { tag: 'plain_text' as const, content: btn.label },
      ...(btn.url
        ? {
            behaviors: [{ type: 'open_url' as const, default_url: btn.url }],
            type: 'default' as const,
          }
        : {
            type: btn.style === 'danger'
              ? 'danger' as const
              : btn.style === 'primary'
                ? 'primary_filled' as const
                : 'default' as const,
            behaviors: [{ type: 'callback' as const, value: { action: btn.callbackData } }],
          }),
    }],
  });

  const hasRows = buttons.some(button => button.row !== undefined);
  if (!hasRows) {
    return [{
      tag: 'column_set',
      flex_mode: 'flow',
      columns: buttons.map(makeButton),
    } as unknown as FeishuCardElement];
  }

  const rowMap = new Map<number, Button[]>();
  for (const button of buttons) {
    const row = button.row ?? Number.MAX_SAFE_INTEGER;
    if (!rowMap.has(row)) rowMap.set(row, []);
    rowMap.get(row)!.push(button);
  }

  return [...rowMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, rowButtons]) => ({
      tag: 'column_set',
      flex_mode: 'flow',
      columns: rowButtons.map(makeButton),
    } as unknown as FeishuCardElement));
}

/**
 * Build Feishu interactive card v1 JSON string.
 * Supports optional colored header + body elements.
 */
export function buildFeishuCard(options: FeishuCardOptions): string {
  const card: Record<string, unknown> = {
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: {
      elements: options.elements,
    },
  };

  if (options.header) {
    card.header = {
      template: options.header.template,
      title: { tag: 'plain_text', content: options.header.title },
    };
  }

  return JSON.stringify(card);
}
