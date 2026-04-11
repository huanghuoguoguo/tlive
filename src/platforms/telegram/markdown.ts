import { markdownToHtml } from '../../markdown/ir.js';

export function markdownToTelegram(text: string): string {
  return markdownToHtml(text);
}