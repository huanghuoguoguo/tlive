/**
 * Session formatting utilities — shared across session commands.
 */

import type { Locale } from '../i18n/index.js';
import { t } from '../i18n/index.js';

/** Format file size in human-readable form */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** Format session modification date in localized form */
export function formatSessionDate(mtime: number, locale: Locale): string {
  return new Date(mtime).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Format timestamp as relative time (e.g., "5分钟前", "2小时前") */
export function formatRelativeTime(timestamp: number, locale: Locale): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return t(locale, 'format.justNow');
  if (diffMin < 60) return t(locale, 'format.minAgo').replace('{count}', String(diffMin));
  if (diffHour < 24) return t(locale, 'format.hourAgo').replace('{count}', String(diffHour));
  if (diffDay < 7) return t(locale, 'format.dayAgo').replace('{count}', String(diffDay));
  return new Date(timestamp).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
  });
}
