import type { FeishuCardElement } from './types.js';

export type FeishuHeaderTemplate = 'blue' | 'green' | 'orange' | 'red' | 'purple' | 'indigo' | 'yellow' | 'turquoise';

export interface FeishuCardOptions {
  header?: {
    template: FeishuHeaderTemplate;
    title: string;
  };
  elements: FeishuCardElement[];
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
