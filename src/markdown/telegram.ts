import { markdownToHtml } from './ir.js';

export function markdownToTelegram(text: string): string {
  return markdownToHtml(text);
}
