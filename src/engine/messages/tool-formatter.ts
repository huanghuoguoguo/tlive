/**
 * Tool input formatter — brief display for progress messages.
 * Extracted from MessageRenderer for cleaner architecture.
 */

import { truncate } from '../../core/string.js';
import { shortPath } from '../../core/path.js';

/** Format tool input for brief progress display */
export function formatToolInput(name: string, input?: Record<string, unknown>): string {
  if (!input) return '';
  switch (name) {
    case 'Bash':
      return truncate(String(input.command || ''), 60);
    case 'Read':
      return shortPath(String(input.file_path || ''));
    case 'Edit':
    case 'Write':
      return shortPath(String(input.file_path || ''));
    case 'Grep':
      return `"${truncate(String(input.pattern || ''), 30)}" in ${input.path ? shortPath(String(input.path)) : 'files'}`;
    case 'Glob':
      return String(input.pattern || '');
    case 'WebFetch':
      return truncate(String(input.url || ''), 50);
    case 'Agent':
      return truncate(String(input.description || input.prompt || ''), 50);
    default: {
      // Show first meaningful field
      const keys = ['file_path', 'path', 'command', 'url', 'pattern', 'query'];
      for (const key of keys) {
        if (input[key]) {
          return truncate(String(input[key]), 50);
        }
      }
      return '';
    }
  }
}